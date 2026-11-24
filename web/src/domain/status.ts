import type { EffectiveState, RunState, SessionState, VisualShape, VisualStateKey, VisualTone } from './states';
import type { Delivery, Task } from './work';

/** Failed/stopped/superseded deliveries are inspectable, but cannot be accepted by the backend. */
export function isReviewableDelivery(d: Delivery, task?: Pick<Task, 'status'>): boolean {
  return !d.redacted && d.decided_at == null && ['needs_review', 'succeeded'].includes(d.outcome ?? '')
    && (!task || ['needs_review', 'succeeded'].includes(task.status));
}

/** What `effectiveState` needs besides the task row. Every page passes the same three sources. */
export interface EffectiveContext {
  /** Live run per task id (presence / overview running rows). */
  activeRuns?: Readonly<Record<string, { state: RunState } | undefined>>;
  /** `/sessions` rows. */
  sessions?: ReadonlyArray<{ task_id: string | null; state: SessionState }>;
  /** Unresolved approvals, questions and reviews. */
  pending?: ReadonlyArray<{ task_id: string | null; resolved?: boolean }>;
}

const awaitingRun = (state: RunState | undefined) => state != null && (state.startsWith('awaiting') || state === 'waiting_user');
const awaitingSession = (state: SessionState | undefined) => state === 'awaiting_approval' || state === 'awaiting_input';

/**
 * Task group: proposed / waiting_user / needs_review, an awaiting run, an external session
 * awaiting approval or input, or any unresolved pending item make the task "等你"; otherwise the status decides.
 */
export function effectiveState(task: Pick<Task, 'id' | 'status'>, ctx: EffectiveContext = {}): EffectiveState {
  if (['failed', 'rejected', 'denied'].includes(task.status)) return 'failed';
  if (['interrupted', 'cancelled', 'expired'].includes(task.status)) return 'stopped';
  if (['succeeded', 'accepted'].includes(task.status) && !ctx.pending?.some((p) => p.task_id === task.id && !p.resolved)) return 'done';
  const session = ctx.sessions?.find((s) => s.task_id === task.id);
  if (
    task.status === 'needs_review' ||
    task.status === 'proposed' ||
    task.status === 'waiting_user' ||
    awaitingRun(ctx.activeRuns?.[task.id]?.state) ||
    awaitingSession(session?.state) ||
    ctx.pending?.some((p) => p.task_id === task.id && !p.resolved)
  ) {
    return 'waiting';
  }
  switch (task.status) {
    case 'succeeded':
    case 'accepted':
      return 'done';
    case 'failed':
    case 'rejected':
    case 'denied':
      return 'failed';
    case 'interrupted':
    case 'cancelled':
    case 'expired':
      return 'stopped';
    default:
      if (session?.state === 'idle') return 'idle';
      if (session?.state === 'error') return 'failed';
      return 'running';
  }
}

/** Per-group task counts (task legend, tab badges). */
export function countByEffectiveState(
  tasks: ReadonlyArray<Pick<Task, 'id' | 'status'>>,
  ctx: EffectiveContext = {},
): Record<EffectiveState, number> {
  const out: Record<EffectiveState, number> = { waiting: 0, running: 0, idle: 0, done: 0, failed: 0, stopped: 0 };
  for (const t of tasks) out[effectiveState(t, ctx)] += 1;
  return out;
}

/** The single "等你" count: waiting tasks and unresolved items. Sidebar, overview, tasks and desktop all use it. */
export function countWaiting(
  tasks: ReadonlyArray<Pick<Task, 'id' | 'status'>>,
  ctx: EffectiveContext = {},
): { tasks: number; items: number } {
  return {
    tasks: tasks.filter((t) => effectiveState(t, ctx) === 'waiting').length,
    items: (ctx.pending ?? []).filter((p) => !p.resolved).length,
  };
}

export interface StateVisual {
  tone: VisualTone;
  shape: VisualShape;
  /** Text channel, always shown or read out. */
  label: string;
  /** CSS custom property name for the colour channel. */
  token: string;
}

const TOKEN: Record<VisualTone, string> = {
  ok: '--ef-state-ok',
  failed: '--ef-state-failed',
  warning: '--ef-state-warning',
  waiting: '--ef-state-waiting',
  running: '--ef-state-running',
  idle: '--ef-state-idle',
  cancelled: '--ef-state-cancelled',
};

const SHAPE: Record<VisualTone, VisualShape> = {
  ok: 'check',
  failed: 'square',
  warning: 'triangle',
  waiting: 'diamond',
  running: 'ring',
  idle: 'dot',
  cancelled: 'hollow-square',
};

const MAP: Record<VisualStateKey, [VisualTone, string]> = {
  queued: ['idle', '排队中'],
  thinking: ['running', '在想'],
  running_tool: ['running', '在跑'],
  verifying: ['running', '验证中'],
  running: ['running', '进行中'],
  in_progress: ['running', '进行中'],
  current: ['running', '当前'],
  awaiting_input: ['waiting', '待回答'],
  waiting_user: ['waiting', '待回答'],
  proposed: ['waiting', '待批准'],
  approved: ['idle', '已批准'],
  returned: ['running', '已返回'],
  denied: ['failed', '已拒绝'],
  expired: ['cancelled', '已过期'],
  awaiting_approval: ['waiting', '待批准'],
  needs_review: ['waiting', '待复核'],
  waiting: ['waiting', '待处理'],
  produced: ['waiting', '已产出'],
  presented: ['waiting', '已送达'],
  viewed: ['waiting', '已查看'],
  warning: ['warning', '注意'],
  blocked: ['warning', '堵住'],
  paused: ['cancelled', '已暂停'],
  succeeded: ['ok', '已完成'],
  completed: ['ok', '已完成'],
  accepted: ['ok', '已接受'],
  ok: ['ok', '成功'],
  done: ['ok', '已完成'],
  failed: ['failed', '失败'],
  error: ['failed', '出错'],
  broken: ['failed', '断开'],
  cancelled: ['cancelled', '已取消'],
  interrupted: ['cancelled', '已中断'],
  stopped: ['cancelled', '已停止'],
  rejected: ['cancelled', '已退回'],
  idle: ['idle', '空闲'],
  pending: ['idle', '未开始'],
  todo: ['idle', '未到达'],
  unreachable: ['idle', '不可达'],
  skipped: ['idle', '跳过'],
  unknown: ['warning', '回执不全'],
};

/** Colour + shape + text for a state. Interrupted and cancelled share the hollow square. */
export function stateVisual(state: VisualStateKey): StateVisual {
  const [tone, label] = MAP[state];
  return { tone, shape: SHAPE[tone], label, token: TOKEN[tone] };
}
