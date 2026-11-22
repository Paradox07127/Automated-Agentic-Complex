// 02 进行中 rows, today's coding session counts and reminder times, worked out from the overview's reads; no drawing here.
import { formatClock, type Session, type Task } from '../../domain';
import type { DayConv } from './loadBrief';
import type { OverviewSnapshot, Reminder } from './load';

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
