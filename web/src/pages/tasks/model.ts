// Pure state for the task page: local decisions applied on top of what agentd returned.
import {
  countWaiting,
  effectiveState,
  isReviewableDelivery,
  sortPending,
  type ActiveRun,
  fromCodingReview,
  isCodingReview,
  type Delivery,
  type EffectiveContext,
  type EffectiveState,
  type Goal,
  type PendingItem,
  type Plan,
  type Review,
  type Session,
  type Task,
} from '../../domain';
import type { TasksBase } from './useTasksData';

export interface TasksLocal {
  /** Approvals and questions already decided here. */
  resolved: Record<string, true>;
  /** Delivery decisions taken here. */
  decided: Record<string, { state: 'accepted' | 'rejected'; at: number; note?: string }>;
  /** Stop time per task; it holds while the snapshot still shows `stopMark`, what the stop ended. */
  stopped: Record<string, number>;
  stopMark: Record<string, string>;
  /** Tasks created or re-dispatched here, newest first. */
  created: Task[];
  archived: Record<string, true>;
  goalStatus: Record<string, Goal['status']>;
}

export const emptyLocal = (): TasksLocal => ({ resolved: {}, decided: {}, stopped: {}, stopMark: {}, created: [], archived: {}, goalStatus: {} });

export interface TasksView {
  tasks: Task[];
  deliveries: Delivery[];
  /** Unresolved pending items in `sortPending` order. */
  pending: PendingItem[];
  activeRuns: Record<string, ActiveRun>;
  sessions: Session[];
  ctx: EffectiveContext;
  effective: Record<string, EffectiveState>;
  /** Stop time of each task whose local stop still holds. */
  stopped: Record<string, number>;
  /** The one "等你" count: waiting tasks and unresolved items. */
  waiting: { tasks: number; items: number };
  goals: Goal[];
}

function reviewOf(d: Delivery, task: Task | undefined): Review {
  const title = task?.title ?? d.task_id;
  return {
    id: `r-${d.id}`,
    kind: 'review',
    task_id: d.task_id,
    delivery_id: d.id,
    title: `${title} v${d.version}`,
    source: `角色任务 │ ${title}`,
    since: d.presented_at ?? d.produced_at,
    revision: d.revision,
    generation: d.generation,
    verification_source: d.verification_source,
  };
}

/** What a stop ends: the own session's turn as it stands, else the live run, else the row as it stands. */
export function stopMark(t: Pick<Task, 'id' | 'status' | 'updated_at'>, base: Pick<TasksBase, 'sessions' | 'activeRuns'>): string {
  const s = base.sessions.find((x) => x.own && x.task_id === t.id);
  if (s) return `session:${s.id}:${s.state}:${s.since}`;
  const run = base.activeRuns[t.id];
  return run ? `run:${run.run_id}:${run.generation}` : `task:${t.status}:${t.updated_at}`;
}

export function deriveView(base: TasksBase, local: TasksLocal): TasksView {
  // Once the snapshot shows the stopped run settled, or a newer one, the snapshot decides again.
  const stopped = Object.fromEntries([...local.created, ...base.tasks].flatMap((t) => {
    const at = local.stopped[t.id];
    return at != null && local.stopMark[t.id] === stopMark(t, base) ? [[t.id, at] as const] : [];
  }));
  const deliveries = base.deliveries.map((d) => {
    const dec = local.decided[d.id];
    return dec ? { ...d, state: dec.state, decided_at: dec.at } : d;
  });
  const latest = (taskId: string) => deliveries.filter((d) => d.task_id === taskId).sort((a, b) => b.version - a.version)[0];
  const tasks = [...local.created, ...base.tasks].map((t): Task => {
    const at = stopped[t.id];
    if (at != null) return { ...t, status: 'cancelled', ended_at: at };
    const dec = latest(t.id);
    if (dec && t.delivery?.id === dec.id && local.decided[dec.id]) return { ...t, status: dec.state === 'accepted' ? 'accepted' : 'rejected' };
    return t;
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // An earlier version left undecided by a rerun is superseded: deciding it fails.
  const reviews = [
    ...deliveries.filter((d) => isReviewableDelivery(d, byId.get(d.task_id)) && byId.get(d.task_id)?.delivery?.id === d.id).map((d) => reviewOf(d, byId.get(d.task_id))),
    ...tasks.filter(isCodingReview).map(fromCodingReview),
  ];
  const pending = sortPending(
    [...base.questions, ...base.approvals, ...reviews].filter((p) => !local.resolved[p.id] && (p.task_id == null || stopped[p.task_id] == null)),
  );
  const activeRuns = Object.fromEntries(Object.entries(base.activeRuns).filter(([id]) => stopped[id] == null));
  const sessions = base.sessions.filter((s) => s.task_id == null || stopped[s.task_id] == null);
  const ctx: EffectiveContext = { activeRuns, sessions, pending };
  const effective = Object.fromEntries(tasks.map((t) => [t.id, effectiveState(t, ctx)]));
  const goals = base.goals.map((g) => (local.goalStatus[g.id] ? { ...g, status: local.goalStatus[g.id] as Goal['status'] } : g));
  return { tasks, deliveries, pending, activeRuns, sessions, ctx, effective, stopped, waiting: countWaiting(tasks, ctx), goals };
}

/** After an item leaves the list, select the one that took its place (or the new last one). */
export function nextAfter(ids: readonly string[], removed: string): string | null {
  const i = ids.indexOf(removed);
  const rest = ids.filter((id) => id !== removed);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? null;
}

/** jobs.py cancel settles a job only from these. */
const JOB_STOP = ['queued', 'running', 'waiting_user', 'interrupted'];
/** An own session's turn is running (own.py LIVE_STATES, and a turn still starting). */
const TURN_LIVE = ['accepted', 'running', 'thinking', 'running_tool', 'awaiting_approval'];

/** Tasks a stop can apply to, by the route stopOne takes: a job agentd can cancel, an own session's live turn, else a live row. */
export function stoppable(t: Task, view: Pick<TasksView, 'sessions'>): boolean {
  if (t.source === 'ext') return false;
  if (t.job_id) return JOB_STOP.includes(t.status);
  const session = t.target === 'character' && t.task_id ? undefined : view.sessions.find((s) => s.own && s.task_id === t.id);
  if (session) return TURN_LIVE.includes(session.state);
  return ['running', 'queued', 'waiting_user', 'returned', 'verifying', 'needs_review'].includes(t.status);
}

/** A task's open items: those naming it, and approvals of its own coding session (approvals carry no task id). */
export function pendingOf(view: Pick<TasksView, 'pending' | 'sessions'>, taskId: string): PendingItem[] {
  const sessions = new Set(view.sessions.filter((s) => s.task_id === taskId).map((s) => s.id));
  return view.pending.filter((p) => p.task_id === taskId || (p.kind === 'approval' && p.task_id == null && (sessions.has(p.session_id) || sessions.has(p.display_session ?? ''))));
}

/** Feed plans laid onto the snapshot: each task whose run has a plan gets its steps, and its live run the plan. */
export function withPlans(base: TasksBase, plans: Readonly<Record<string, Plan>>): TasksBase {
  if (Object.keys(plans).length === 0) return base;
  const tasks = base.tasks.map((t) => {
    const plan = t.run_id ? plans[t.run_id] : undefined;
    return plan ? { ...t, steps: plan.steps, steps_done: plan.steps.filter((s) => s.status === 'completed').length, steps_total: plan.steps.length } : t;
  });
  const activeRuns = Object.fromEntries(Object.entries(base.activeRuns).map(([id, r]) => [id, plans[r.run_id] ? { ...r, plan: plans[r.run_id] ?? null } : r]));
  return { ...base, tasks, activeRuns };
}
