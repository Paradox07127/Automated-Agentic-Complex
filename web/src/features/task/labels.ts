// Text for task source and status, shared by the task list, detail and drawer.
import { formatClock, stateVisual, type EffectiveState, type PendingItem, type Task, type VisualStateKey } from '../../domain';

export function sourceLabel(task: Pick<Task, 'source' | 'agent'>): string {
  if (task.source === 'role') return '角色任务';
  return `${task.agent ?? ''} │ ${task.source === 'code' ? '编码会话' : '外部会话'}`;
}

/** State key for the status lamp (StatusTag while waiting): stopped and queued get their own glyphs, everything else follows effectiveState. */
export function statusKey(task: Pick<Task, 'status'>, effective: EffectiveState, stoppedAt: number | null = null): VisualStateKey {
  if (stoppedAt != null || task.status === 'cancelled' || task.status === 'interrupted') return task.status === 'interrupted' ? 'interrupted' : 'stopped';
  if (task.status === 'queued' && effective === 'running') return 'queued';
  return effective;
}

/** Status label: waiting says what it waits for ("◆ 等你批准 · 2 张"); stopped carries its time. */
export function statusLabel(task: Pick<Task, 'status'>, effective: EffectiveState, pending: readonly PendingItem[], stoppedAt: number | null = null): string {
  const key = statusKey(task, effective, stoppedAt);
  if (key === 'stopped') return stoppedAt != null ? `已取消 │ ${formatClock(stoppedAt)}` : stateVisual('cancelled').label;
  if (effective === 'waiting') {
    const open = pending.filter((p) => !p.resolved);
    const approvals = open.filter((p) => p.kind === 'approval').length;
    if (approvals > 0) return `待批准 │ ${approvals} 张`;
    if (task.status === 'needs_review' || open.some((p) => p.kind === 'review')) return '待复核';
    if (open.some((p) => p.kind === 'question')) return '待回答';
    return stateVisual('awaiting_approval').label;
  }
  return stateVisual(key).label;
}
