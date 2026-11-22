// 动作线: the T1 events of one stretch of time as parallel lanes (inputs by source, stage, decisions, renderer
// feedback, speech), and the walk along `causation_id` up to an event's causes and down to its effects.
import { isoToMs } from '../../domain';

/** A `/trace/*` event with the fields the lanes read (trace_store.py `_emit`). */
export interface LaneEvent {
  event_id: string;
  trace_id: string;
  causation_id: string | null;
  kind: string;
  status: string;
  producer: string;
  t_wall: string;
  duration_ms?: number;
  attrs: Record<string, unknown>;
}

/** `signal.changed` sources, in lane order. */
export const SOURCES = ['coarse', 'content', 'pointer', 'attention', 'present', 'touch', 'override', 'pause'] as const;
export type Source = (typeof SOURCES)[number];
export type LaneId = `in.${Source}` | 'stage' | 'decide' | 'body' | 'speech';
export const LANE_ORDER: LaneId[] = [...SOURCES.map((s): LaneId => `in.${s}`), 'stage', 'decide', 'body', 'speech'];
export const LANE_NAME: Readonly<Record<LaneId, string>> = {
  'in.coarse': '粗判', 'in.content': '内容', 'in.pointer': '指针', 'in.attention': '注意力', 'in.present': '展示', 'in.touch': '触碰',
  'in.override': '手动', 'in.pause': '暂停', stage: '舞台', decide: '决定', body: '渲染器', speech: '语音',
};

const DECIDE = new Set(['motion.chosen', 'behavior.refused', 'behavior.dispatched']);
const BODY = new Set(['motion.state', 'behavior.receipt']);

/** The lane an event is drawn in; null for a kind the lanes do not draw (it still counts in the causation walk). */
export function laneOf(e: Pick<LaneEvent, 'kind' | 'attrs'>): LaneId | null {
  if (e.kind === 'signal.changed') {
    const s = e.attrs.source;
    return (SOURCES as readonly unknown[]).includes(s) ? `in.${s as Source}` : null;
  }
  if (e.kind === 'stage.changed') return 'stage';
  if (DECIDE.has(e.kind)) return 'decide';
  if (BODY.has(e.kind)) return 'body';
  if (e.kind.startsWith('speech.') || e.kind.startsWith('playback.')) return 'speech';
  return null;
}

/** The lanes to draw, in order: every non-input lane, and the input lanes that have an event. */
export function lanesOf(events: readonly LaneEvent[]): LaneId[] {
  const seen = new Set(events.map(laneOf));
  return LANE_ORDER.filter((l) => !l.startsWith('in.') || seen.has(l));
}

/** The time range picker, minutes back from now. */
export const RANGES = [5, 15, 60] as const;
export type Range = (typeof RANGES)[number];

export const inWindow = (events: readonly LaneEvent[], t0: number, t1: number) =>
  events.filter((e) => {
    const t = isoToMs(e.t_wall);
    return t >= t0 && t <= t1;
  });

export interface Walk {
  byId: ReadonlyMap<string, LaneEvent>;
  children: ReadonlyMap<string, LaneEvent[]>;
}

export function walkOf(events: readonly LaneEvent[]): Walk {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const children = new Map<string, LaneEvent[]>();
  for (const e of events) {
    if (e.causation_id == null) continue;
    const list = children.get(e.causation_id);
    if (list) list.push(e);
    else children.set(e.causation_id, [e]);
  }
  return { byId, children };
}

/** The chain of causes, nearest first; stops at a root or at an event outside the stretch. */
export function causesOf(w: Walk, id: string): LaneEvent[] {
  const out: LaneEvent[] = [];
  const seen = new Set([id]);
  let up = w.byId.get(id)?.causation_id ?? null;
  while (up != null && !seen.has(up)) {
    const e = w.byId.get(up);
    if (!e) break;
    out.push(e);
    seen.add(up);
    up = e.causation_id;
  }
  return out;
}

/** Everything the event caused, directly or through others, breadth first. */
export function effectsOf(w: Walk, id: string): LaneEvent[] {
  const out: LaneEvent[] = [];
  const seen = new Set([id]);
  const queue = [id];
  for (let i = 0; i < queue.length; i += 1) {
    for (const c of w.children.get(queue[i]!) ?? []) {
      if (seen.has(c.event_id)) continue;
      seen.add(c.event_id);
      out.push(c);
      queue.push(c.event_id);
    }
  }
  return out;
}

const STAGE: Readonly<Record<string, string>> = { offstage: '离场', quiet: '安静', normal: '平常', engaged: '投入' };
const PHASE: Readonly<Record<string, string>> = {
  started: '开始', cycle_end: '一圈', ended: '结束', expired: '到期', rejected: '拒播', prepared: '备好', running: '在播', completed: '完成',
  blocked: '挡下', cancelled: '取消',
};
const SPEECH: Readonly<Record<string, string>> = {
  'speech.requested': '要语音', 'speech.first_audio': '首段音频', 'speech.finished': '合成完', 'playback.started': '开播', 'playback.ended': '播完',
  'playback.interrupted': '打断', 'playback.buffering': '缓冲', 'playback.resumed': '续播', 'playback.degraded': '降级',
};

const str = (v: unknown) => (v == null ? '—' : typeof v === 'object' ? String((v as { head?: unknown }).head ?? '…') : String(v));

/** One line naming what the event says. */
export function labelOf(e: LaneEvent): string {
  const a = e.attrs;
  switch (e.kind) {
    case 'signal.changed':
      return `${str(a.key)} → ${str(a.value)}`;
    case 'stage.changed':
      return `${STAGE[str(a.from)] ?? str(a.from)} → ${STAGE[str(a.to)] ?? str(a.to)}`;
    case 'motion.chosen':
      return `选 ${str(a.clip)}`;
    case 'behavior.refused':
      return `拒绝 ${str(a.trigger_event ?? a.behavior_type)} │ ${str(a.reason)}`;
    case 'behavior.dispatched':
      return `发出 ${str(a.behavior_type)}`;
    case 'motion.state':
      return `${str(a.clip)} ${PHASE[str(a.phase)] ?? str(a.phase)}`;
    case 'behavior.receipt':
      return `${str(a.behavior_type)} ${PHASE[str(a.phase)] ?? str(a.phase)}${a.reason ? ` │ ${str(a.reason)}` : ''}`;
    default:
      return SPEECH[e.kind] ?? e.kind;
  }
}

/** How a mark is drawn: a refusal or a failure, the user's own play, or the usual. */
export type Tone = 'bad' | 'user' | 'ok';
export function toneOf(e: LaneEvent): Tone {
  const a = e.attrs;
  if (a.origin === 'user' || a.reason === 'user_play') return 'user';
  if (e.kind === 'behavior.refused' || e.status !== 'ok' || a.phase === 'rejected' || a.reason === 'connection_lost') return 'bad';
  return 'ok';
}

/** Sub-rows within one lane so marks closer than `gap` (fraction of the width) do not cover each other. */
export function pack(xs: readonly number[], gap: number, rows: number): number[] {
  const last: number[] = [];
  return xs.map((x) => {
    let r = last.findIndex((l) => x - l >= gap);
    if (r < 0) r = last.length < rows ? last.length : rows - 1;
    last[r] = x;
    return r;
  });
}
