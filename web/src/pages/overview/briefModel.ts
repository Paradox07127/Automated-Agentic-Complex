// 03 今日简报 and 02 进行中, worked out from the overview's reads; no drawing here.
import type { TimelineItem, TimelineLaneSpec } from '../../charts';
import { formatClock, type Delivery, type Session, type Task } from '../../domain';
import type { DayConv, DayEpisode, OverviewBrief, Spoke } from './loadBrief';
import type { OverviewSnapshot, Reminder } from './load';
import type { NavTarget } from './nav';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A chat turn shorter than this still reads as a block on the work lane. */
const TURN_MIN = 4 * MIN;

const floorHour = (t: number) => {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

/** The brief's window: from the first item (at least 5½ h back, not before midnight) to the hour after now. */
export function briefWindow(now: number, first: number | null): [number, number] {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const t0 = Math.max(midnight, floorHour(Math.min(first ?? now, now - 5.5 * HOUR)));
  return [t0, floorHour(now + HOUR - 1) + HOUR];
}

/** Session states that count as 待审批 in the summary and the 02 rows. */
const WAITING = new Set(['awaiting_approval', 'awaiting_input']);

/** Active coding sessions, ordered by live state. */
const CODE_ORDER: Readonly<Record<string, number>> = { running_tool: 1, running: 1, accepted: 1, thinking: 2, compacting: 2, subagent: 2, awaiting_approval: 3, awaiting_input: 3 };

export type RunRow =
  | { k: 'conv'; id: string; conv: DayConv }
  | { k: 'task'; id: string; task: Task }
  | { k: 'code'; id: string; session: Session; started: number | null };

/** Live coding sessions in 02 order; `started` is the session's first ledger time today when /day/segments has it. */
export function codeRows(snap: OverviewSnapshot): Array<RunRow & { k: 'code' }> {
  const starts = new Map(snap.day.segments.flatMap((g) => g.sessions.map((s) => [s.id, s.started_at] as const)));
  return snap.sessions
    .filter((s) => CODE_ORDER[s.state] != null)
    .sort((a, b) => (CODE_ORDER[a.state] ?? 9) - (CODE_ORDER[b.state] ?? 9))
    .map((s) => ({ k: 'code', id: s.id, session: s, started: starts.get(s.id) ?? null }));
}

/** Active work only. Anything waiting for a user decision belongs to 待处理. */
export function runRows(snap: OverviewSnapshot, convs: readonly DayConv[]): { rows: RunRow[]; convs: number; code: number } {
  const busy = convs.filter((c) => c.busy);
  const pending = new Set(snap.pending.filter((p) => !p.resolved && p.task_id).map((p) => p.task_id));
  const tasks = snap.tasks.filter((t) => t.source === 'role' && snap.active_runs[t.id] && !pending.has(t.id));
  const code = codeRows(snap).filter((row) => !row.session.task_id || !pending.has(row.session.task_id));
  const conv = (c: DayConv): RunRow => ({ k: 'conv', id: c.id, conv: c });
  return {
    rows: [...busy.map(conv), ...tasks.map((t): RunRow => ({ k: 'task', id: t.id, task: t })), ...code],
    convs: busy.length,
    code: code.length,
  };
}

/** Today's coding sessions (/day/segments) by state: live ones split by the registry's state, the rest finished. */
export function codeCounts(snap: OverviewSnapshot): { total: number; running: number; waiting: number; done: number } {
  const all = snap.day.segments.flatMap((g) => g.sessions);
  const live = (id: string) => snap.sessions.find((s) => s.id === id);
  let running = 0;
  let waiting = 0;
  for (const s of all) {
    if (s.ended_at != null) continue;
    if (WAITING.has(live(s.id)?.state ?? '')) waiting += 1;
    else running += 1;
  }
  return { total: all.length, running, waiting, done: all.length - running - waiting };
}

const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Due time: HH:MM today, 明天 HH:MM, else M/D HH:MM. */
export function reminderTime(due: number, now: number): string {
  const days = Math.round((dayStart(due) - dayStart(now)) / 86_400_000);
  if (days === 0) return formatClock(due);
  if (days === 1) return `明天 ${formatClock(due)}`;
  const d = new Date(due);
  return `${d.getMonth() + 1}/${d.getDate()} ${formatClock(due)}`;
}

/** The next armed reminder after now. */
export const nextReminder = (rs: readonly Reminder[], now: number): Reminder | null =>
  rs.filter((r) => !r.triggered && r.due_at > now).sort((a, b) => a.due_at - b.due_at)[0] ?? null;

interface Span {
  t0: number;
  t1: number;
  who: string[];
  to: NavTarget;
}

/** 对话与任务: each chat turn (at least 4 minutes), each coding session and role task run, overlapping ones merged into one block. */
export function workSpans(snap: OverviewSnapshot, convs: readonly DayConv[], now: number): Span[] {
  const title = (id: string) => snap.sessions.find((s) => s.id === id)?.title;
  const parts: Span[] = [
    ...convs.flatMap((c) => c.turns.map((t) => ({ t0: t.t0, t1: Math.max(t.t1, t.t0 + TURN_MIN), who: [`对话 │ ${c.title}`], to: { page: 'chat', conv: c.id } as NavTarget }))),
    ...snap.day.segments.flatMap((g) =>
      g.sessions.map((s) => {
        const sess = snap.sessions.find((x) => x.id === s.id);
        const to: NavTarget = sess?.task_id ? { page: 'overview', sel: sess.task_id } : { page: 'overview', focus: 'running' };
        return { t0: s.started_at, t1: s.ended_at ?? now, who: [`编码 │ ${title(s.id) ?? g.agent}`], to };
      }),
    ),
    ...snap.day.runs
      .filter((r) => r.task_id)
      .map((r) => ({ t0: r.started_at, t1: r.ended_at ?? now, who: [`角色任务 │ ${snap.tasks.find((t) => t.id === r.task_id)?.title ?? '任务'}`], to: { page: 'overview', sel: r.task_id ?? undefined } as NavTarget })),
  ].sort((a, b) => a.t0 - b.t0);
  const out: Span[] = [];
  for (const x of parts) {
    const g = out[out.length - 1];
    if (g && x.t0 <= g.t1) {
      g.t1 = Math.max(g.t1, x.t1);
      for (const w of x.who) if (!g.who.includes(w)) g.who.push(w);
      // A block with a task opens that task; a chat-only block opens the chat.
      if (g.to.page === 'chat' && x.to.page === 'overview') g.to = x.to;
    } else out.push({ ...x, who: [...x.who] });
  }
  return out.map((g) => ({ ...g, t1: Math.min(g.t1, now) }));
}

const spanTip = (g: Span, now: number) =>
  `对话与任务 │ ${formatClock(g.t0)}–${g.t1 >= now ? '现在' : formatClock(g.t1)}\n${g.who.slice(0, 4).join('\n')}${g.who.length > 4 ? `\n另有 ${g.who.length - 4} 项` : ''}`;

/** A spoken line on the 主动发言 lane: proactive decisions, and deliveries announced today. */
export interface Said {
  t: number;
  label: string;
  kind: '主动发起' | '播报';
}

export function saidOf(spoke: readonly Spoke[], deliveries: readonly Delivery[], t0: number, now: number): Said[] {
  return [
    ...spoke.map((s): Said => ({ t: s.t, label: '主动发起', kind: '主动发起' })),
    ...deliveries.filter((d) => d.presented_at != null && d.presented_at >= t0 && d.presented_at <= now).map((d): Said => ({ t: d.presented_at ?? 0, label: `${d.title} v${d.version}`, kind: '播报' })),
  ].sort((a, b) => a.t - b.t);
}

export interface BriefLanes {
  lanes: TimelineLaneSpec[];
  t0: number;
  t1: number;
  marks: Array<{ t: number; label: string; kind?: 'done' }>;
}

/** The three lanes of the brief's timeline, and today's reminders as ▼ on its ruler. */
/** 「，已显示」 for a reminder whose card was on screen, with the time when it is not the due minute (the mark already shows that). */
function seenNote(r: { due_at: number; seen_at: number | null }): string {
  if (r.seen_at === null) return '';
  const shown = formatClock(r.seen_at);
  return shown === formatClock(r.due_at) ? '，已显示' : `，已显示 ${shown}`;
}

export function briefLanes(snap: OverviewSnapshot, brief: OverviewBrief, now: number): BriefLanes {
  const eps: DayEpisode[] = brief.episodes ?? [];
  const convs = brief.convs ?? [];
  const work = workSpans(snap, convs, now);
  const firsts = [eps[0]?.t0, work[0]?.t0].filter((x): x is number => x != null);
  const [t0, t1] = briefWindow(now, firsts.length ? Math.min(...firsts) : null);
  const said = saidOf(brief.spoke ?? [], snap.deliveries, t0, now);
  const lanes: TimelineLaneSpec[] = [
    {
      id: 'doing',
      label: '用户活动',
      kind: 'spans',
      items: eps.map((e): TimelineItem => ({ id: e.id, t0: e.t0, t1: Math.min(e.t1, now), label: e.app, tip: `用户活动 │ ${e.app}\n${e.title}\n${formatClock(e.t0)}–${formatClock(Math.min(e.t1, now))}`, to: { page: 'overview', focus: 'timeline' } })),
    },
    {
      id: 'work',
      label: '对话与任务',
      kind: 'blocks',
      items: work.map((g, i): TimelineItem => ({ id: `w${i}`, t0: g.t0, t1: g.t1, label: g.who.length > 1 ? `${g.who.length} 项` : g.who[0]?.split(' │ ')[1], tip: spanTip(g, now), to: g.to })),
    },
    {
      id: 'said',
      label: '主动发言',
      kind: 'markers',
      items: said.map((s, i): TimelineItem => ({ id: `s${i}`, t: s.t, label: s.label, kind: 'diamond', tip: `主动发言 │ ${s.kind} │ ${formatClock(s.t)}`, to: { page: 'chat' } })),
    },
  ];
  const marks = snap.reminders
    .filter((r) => r.due_at >= t0 && r.due_at <= t1)
    .map((r) => ({ t: r.due_at, label: `提醒 │ ${r.title}${r.triggered ? '，已提醒' : ''}${seenNote(r)}`, ...(r.triggered ? { kind: 'done' as const } : {}) }));
  return { lanes, t0, t1, marks };
}
