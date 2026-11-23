// 今天 view types, the work-memory (L1 / L2 / L3) views, and the fallbacks built from today's existing reads.
import type { MemoryDaysResponse, MemorySessionsResponse } from '../../bridge/agentd-routes.generated';
import { secToMs, unhidden, type Session } from '../../domain';
import { uuidOf } from '../tasks/board';
import { codeCounts, nextReminder, reminderTime } from './briefModel';
import type { OverviewSnapshot } from './load';
import type { DayConv, DayEpisode } from './loadBrief';
import type { WireDaySegments } from './wire';

export type TodaySource = 'claude' | 'codex' | 'role' | 'own' | 'app' | 'web' | 'chat';

export interface TimelineEntry {
  id: string;
  /** ms */
  t0: number;
  t1: number;
  /** At most 24 characters. */
  title: string;
  source: TodaySource;
  taskId: string | null;
  open: { sel?: string; ep?: string; conv?: string; summary?: string };
  origin: 'l1' | 'episode' | 'segment' | 'conv';
}

export interface DayLine {
  text: string;
  origin: 'l3' | 'local';
  at: number | null;
}

export interface TodayParams {
  sel: string | null;
  open: string | null;
  create: 'role' | 'code' | 'sched' | null;
  ep: string | null;
  day: string | null;
}

export function parseTodayParams(search: string): TodayParams {
  const q = new URLSearchParams(search);
  const c = q.get('create');
  const create = c === 'role' || c === 'code' || c === 'sched' ? c : null;
  return { sel: q.get('sel'), open: q.get('open'), create, ep: q.get('ep'), day: q.get('day') };
}

/**
 * 今天 7 个编码会话，已完成 1 个；下一条提醒 15:20 组会带周报。null when there is neither.
 * Counts 总览 shows elsewhere are left out: conversations (聊了什么), running (进行中) and waiting (待处理) sessions.
 */
export function summaryText(snap: OverviewSnapshot, now: number, codingOn: boolean): string | null {
  const code = codeCounts(snap);
  const next = nextReminder(snap.reminders, now);
  const parts = [
    !codingOn ? '' : code.total ? `今天 ${code.total} 个编码会话${code.done ? `，已完成 ${code.done} 个` : ''}` : '今天还没有编码会话',
    next ? `下一条提醒 ${reminderTime(next.due_at, now)} ${next.title}` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join('；')}。` : null;
}

export type WireSessionSummary = MemorySessionsResponse['sessions'][number];
export type WireDaySummary = MemoryDaysResponse['days'][number];

/** Rows the timeline shows before 展开全部. */
export const TIMELINE_CAP = 30;

const TITLE_MAX = 24;
const short = (t: string) => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t);

const byNewest = (a: TimelineEntry, b: TimelineEntry) => b.t0 - a.t0;

/** L1 session summaries (`/memory/sessions?day=`), newest first. */
export function timelineFromL1(rows: readonly WireSessionSummary[]): TimelineEntry[] {
  return rows
    .map((s): TimelineEntry => ({
      id: s.id,
      t0: secToMs(s.start),
      t1: secToMs(s.end),
      title: short(s.title),
      source: s.agent === 'codex' ? 'codex' : s.agent === 'claude' ? 'claude' : 'app',
      taskId: s.task_id,
      open: { summary: s.id },
      origin: 'l1',
    }))
    .sort(byNewest);
}

/** The L3 headline of `day`; null when there is none. */
export function dayLineFromL3(days: readonly WireDaySummary[], day: string): DayLine | null {
  const d = days.find((x) => x.date === day && x.period === 'day' && x.headline);
  return d ? { text: d.headline, origin: 'l3', at: secToMs(d.generated_at) } : null;
}

/**
 * The fallback timeline, newest first: episodes with same-app neighbours merged, the day's coding sessions
 * (`/day/segments`, titled from the session registry) and the conversations touched that day.
 */
export function timelineFromDay(episodes: readonly DayEpisode[], segments: WireDaySegments | null, convs: readonly DayConv[], sessions: readonly Session[], now: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let prev: { app: string; e: TimelineEntry } | null = null;
  for (const ep of [...episodes].sort((a, b) => a.t0 - b.t0)) {
    if (prev && prev.app === ep.app) {
      prev.e.t1 = Math.max(prev.e.t1, ep.t1);
      continue;
    }
    const e: TimelineEntry = { id: `ep:${ep.id}`, t0: ep.t0, t1: ep.t1, title: short(unhidden(ep.title)), source: 'app', taskId: null, open: { ep: ep.id }, origin: 'episode' };
    out.push(e);
    prev = { app: ep.app, e };
  }
  // The ledger lists a session under each project it ran in (a worktree and its checkout): one entry over all its spans.
  const put = (e: TimelineEntry) => {
    const same = out.find((x) => x.id === e.id);
    if (!same) return void out.push(e);
    same.t0 = Math.min(same.t0, e.t0);
    same.t1 = Math.max(same.t1, e.t1);
  };
  for (const p of segments?.projects ?? []) {
    for (const s of p.sessions) {
      if (s.started_at == null) continue;
      const reg = sessions.find((x) => !x.own && x.id.endsWith(`:${s.session_id}`));
      const sel = reg?.task_id ?? `ses:${uuidOf(s.session_id) ?? s.session_id}`;
      const t1 = s.ended_at == null ? now : secToMs(s.ended_at);
      const source = reg?.target === 'codex' || reg?.id.startsWith('codex:') ? 'codex' : 'claude';
      put({ id: `seg:${s.session_id}`, t0: secToMs(s.started_at), t1, title: short(reg?.title ?? `${p.name} 会话`), source, taskId: reg?.task_id ?? null, open: { sel }, origin: 'segment' });
    }
    for (const o of p.own) {
      const reg = sessions.find((x) => x.id === o.session_id);
      put({ id: `own:${o.session_id}`, t0: secToMs(o.started_at), t1: secToMs(o.updated_at), title: short(o.title ?? reg?.title ?? '编码会话'), source: 'own', taskId: reg?.task_id ?? null, open: { sel: reg?.task_id ?? o.session_id }, origin: 'segment' });
    }
  }
  for (const c of convs) {
    const t0 = c.turns.length ? Math.min(...c.turns.map((t) => t.t0)) : c.updated_at;
    const t1 = c.turns.length ? Math.max(...c.turns.map((t) => t.t1)) : c.updated_at;
    out.push({ id: `conv:${c.id}`, t0, t1, title: short(c.title), source: 'chat', taskId: null, open: { conv: c.id }, origin: 'conv' });
  }
  return out.sort(byNewest);
}
