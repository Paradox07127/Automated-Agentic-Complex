import { get, seg } from '../../bridge/agentd';
import { isoToMs, isoWithOffset, secToMs, type WireConversation, type WireEpisode, type WireStatePoint, type WireTurn } from '../../domain';
import { dayOf } from './load';
import type { WireDecisionEvent } from './wire';

/** One activity segment of today (`/episodes`): its main app and title. */
export interface DayEpisode {
  id: string;
  t0: number;
  t1: number;
  app: string;
  title: string;
}

/** A conversation touched today, with today's turn times and its last reply. */
export interface DayConv {
  id: string;
  title: string;
  /** The active conversation while a turn runs (list's top-level `busy`). */
  busy: boolean;
  updated_at: number;
  turn_count: number;
  turns: Array<{ t0: number; t1: number }>;
  last: string | null;
}

/** A line the character started on her own today (proactive gate said speak). */
export interface Spoke {
  t: number;
}

export interface MoodPoint {
  t: number;
  energy: number;
  valence: number;
}

/** The brief's reads; a null region could not be read and the rest still shows. */
export interface OverviewBrief {
  episodes: DayEpisode[] | null;
  convs: DayConv[] | null;
  spoke: Spoke[] | null;
}

/** Conversations whose turns are read: the newest ones touched today. */
const MAX_CONVS = 8;

const settle = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

const episodeOf = (e: WireEpisode): DayEpisode => ({ id: String(e.id), t0: isoToMs(e.start), t1: isoToMs(e.end), app: e.apps?.[0] ?? '其他', title: e.title });

async function readConvs(now: number): Promise<DayConv[] | null> {
  const list = await settle(get<{ conversations: WireConversation[]; busy?: boolean }>('/conversations'));
  if (!list) return null;
  const today = dayOf(now);
  const rows = list.conversations
    .filter((c) => !c.archived && dayOf(secToMs(c.updated_at)) === today)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, MAX_CONVS);
  return Promise.all(
    rows.map(async (c): Promise<DayConv> => {
      const r = await settle(get<{ turns: WireTurn[] }>(`/conversations/${seg(c.id)}/turns`));
      const turns = (r?.turns ?? []).filter((t) => dayOf(secToMs(t.started_at)) === today);
      const last = [...(r?.turns ?? [])].reverse().find((t) => t.reply)?.reply ?? null;
      return {
        id: c.id,
        title: c.title,
        busy: c.active && !!list.busy,
        updated_at: secToMs(c.updated_at),
        turn_count: c.turn_count,
        turns: turns.map((t) => ({ t0: secToMs(t.started_at), t1: secToMs(t.ended_at ?? t.started_at) })),
        last,
      };
    }),
  );
}

/** The gate categories proactive.py asks about; announcements go through the same gate under their own kinds. */
const PROACTIVE = new Set(['back', 'break', 'stuck', 'comment']);
const spoke = (e: WireDecisionEvent) => e.kind === 'gate.decided' && PROACTIVE.has(String(e.attrs.kind)) && e.attrs.speak === true;

/** `/episodes`, today's conversations and their turns, and proactive decisions. */
export async function loadBrief(now: number): Promise<OverviewBrief> {
  const day0 = new Date(now).setHours(0, 0, 0, 0);
  const today = dayOf(now);
  const [episodes, convs, decisions] = await Promise.all([
    settle(get<{ episodes: WireEpisode[] }>(`/episodes?date=${today}`)),
    readConvs(now),
    settle(get<{ events: WireDecisionEvent[] }>(`/trace/decisions?since=${encodeURIComponent(isoWithOffset(day0))}&limit=200`)),
  ]);
  return {
    episodes: episodes && episodes.episodes.map(episodeOf).sort((a, b) => a.t0 - b.t0),
    convs,
    spoke: decisions && decisions.events.filter(spoke).map((e) => ({ t: isoToMs(e.t_wall) })),
  };
}

/** 24 h of energy and valence for the role band's line, read on its own so a failure can say why. */
export async function readMood(now: number): Promise<MoodPoint[]> {
  const r = await get<{ items: WireStatePoint[] }>(`/character/state/history?since=${Math.floor((now - 86_400_000) / 1000)}`);
  return r.items.map((p) => ({ t: secToMs(p.at), energy: p.energy, valence: p.valence }));
}
