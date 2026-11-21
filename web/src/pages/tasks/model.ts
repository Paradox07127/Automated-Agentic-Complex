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
  /** Artifact paths opened here. */
  opened: Record<string, true>;
  /** Stop time per task. */
  stopped: Record<string, number>;
  /** Tasks created or re-dispatched here, newest first. */
  created: Task[];
  archived: Record<string, true>;
  goalStatus: Record<string, Goal['status']>;
}

export const emptyLocal = (): TasksLocal => ({ resolved: {}, decided: {}, opened: {}, stopped: {}, created: [], archived: {}, goalStatus: {} });

export interface TasksView {
  tasks: Task[];
  deliveries: Delivery[];
  /** Unresolved pending items in `sortPending` order. */
  pending: PendingItem[];
  activeRuns: Record<string, ActiveRun>;
  sessions: Session[];
  ctx: EffectiveContext;
  effective: Record<string, EffectiveState>;
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

export function deriveView(base: TasksBase, local: TasksLocal): TasksView {
  const deliveries = base.deliveries.map((d) => {
    const dec = local.decided[d.id];
    const artifacts = d.artifacts.map((a) => (local.opened[a.path] ? { ...a, opened: true } : a));
    return dec ? { ...d, artifacts, state: dec.state, decided_at: dec.at } : { ...d, artifacts };
  });
  const latest = (taskId: string) => deliveries.filter((d) => d.task_id === taskId).sort((a, b) => b.version - a.version)[0];
  const tasks = [...local.created, ...base.tasks].map((t): Task => {
    const at = local.stopped[t.id];
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
    [...base.questions, ...base.approvals, ...reviews].filter((p) => !local.resolved[p.id] && (p.task_id == null || local.stopped[p.task_id] == null)),
  );
  const activeRuns = Object.fromEntries(Object.entries(base.activeRuns).filter(([id]) => local.stopped[id] == null));
  const sessions = base.sessions.filter((s) => s.task_id == null || local.stopped[s.task_id] == null);
  const ctx: EffectiveContext = { activeRuns, sessions, pending };
  const effective = Object.fromEntries(tasks.map((t) => [t.id, effectiveState(t, ctx)]));
  const goals = base.goals.map((g) => (local.goalStatus[g.id] ? { ...g, status: local.goalStatus[g.id] as Goal['status'] } : g));
  return { tasks, deliveries, pending, activeRuns, sessions, ctx, effective, waiting: countWaiting(tasks, ctx), goals };
}

/** After an item leaves the list, select the one that took its place (or the new last one). */
export function nextAfter(ids: readonly string[], removed: string): string | null {
  const i = ids.indexOf(removed);
  const rest = ids.filter((id) => id !== removed);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? null;
}

/** Tasks a stop can apply to: not external, not finished. */
export function stoppable(t: Pick<Task, 'source' | 'status'>): boolean {
  return t.source !== 'ext' && ['running', 'queued', 'waiting_user', 'returned', 'verifying', 'needs_review'].includes(t.status);
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
