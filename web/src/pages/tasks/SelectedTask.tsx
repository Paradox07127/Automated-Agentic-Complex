import { useState } from 'react';
import type { Task } from '../../domain';
import type { DecideFailCode, TaskAction } from '../../features/task';
import type { NativeOff } from './actions';
import type { ReceiptKind } from './live';
import { pendingOf, type TasksView } from './model';
import { SessionMenu } from './SessionMenu';
import { TaskView } from './TaskView';
import { useSessionLines, useTaskExtras } from './useTasksData';

export interface SelectedTaskProps {
  task: Task;
  view: TasksView;
  now: number;
  stoppedAt: number | null;
  stepsFail: boolean;
  retry: number;
  toolFocus: string | null;
  decideFail: DecideFailCode | null;
  busy: boolean;
  kernelName?: string;
  canReveal: boolean;
  nativeOff?: NativeOff;
  onReceipt: (deliveryId: string, kind: ReceiptKind) => void;
  onAction: (a: TaskAction) => void;
  onReview?: (verdict: 'accept' | 'reject') => void;
}

/** Loads step, tool and file data, run results and the coding session's lines for the selected task; sends the viewed receipt. */
export function SelectedTask({ task, view, now, stoppedAt, stepsFail, retry, toolFocus, decideFail, busy, kernelName, canReveal, nativeOff, onReceipt, onAction, onReview }: SelectedTaskProps) {
  const [pages, setPages] = useState(1);
  const extras = useTaskExtras(task, stepsFail, retry, pages);
  const x = extras.data;
  const deliveries = view.deliveries.filter((d) => d.task_id === task.id).sort((a, b) => a.version - b.version);
  const session = view.sessions.find((s) => s.task_id === task.id) ?? null;
  const codeLive = task.source === 'code' && task.status === 'running' && stoppedAt == null;
  const lines = useSessionLines(codeLive && session?.own ? session.id : null, retry);
  const plan = x?.plan ?? null;
  // The feed plan already on the row wins over the plan item read with the steps.
  const shown: Task = {
    ...task,
    ...(plan && task.steps.length === 0 ? { steps: plan.steps, steps_done: plan.steps.filter((s) => s.status === 'completed').length, steps_total: plan.steps.length } : {}),
    ...(x?.failure && !task.failure ? { failure: x.failure } : {}),
  };
  const status = extras.isPending ? 'loading' : x?.stepsFailed ? 'error' : 'ok';
  return (
    <TaskView
      task={shown}
      effective={view.effective[task.id] ?? 'running'}
      now={now}
      deliveries={deliveries}
      pending={pendingOf(view, task.id)}
      activeRun={view.activeRuns[task.id] ?? null}
      steps={x?.steps ?? []}
      tools={x?.tools ?? []}
      files={x?.files ?? []}
      runs={x?.runs ?? []}
      sessionLines={codeLive ? (lines.data ?? null) : null}
      linesFailed={codeLive && lines.isError}
      onRetryLines={() => void lines.refetch()}
      moreSteps={x?.moreSteps ?? false}
      onMoreSteps={() => setPages((p) => p + 1)}
      stepsStatus={status}
      sessionId={session?.id ?? null}
      decideFail={decideFail}
      decideBusy={busy}
      canReveal={canReveal}
      nativeOff={nativeOff}
      kernelName={kernelName}
      toolFocus={toolFocus}
      stoppedAt={stoppedAt}
      onAction={onAction}
      onReceipt={onReceipt}
      onReview={onReview}
      menu={task.source === 'code' && session?.own ? <SessionMenu sessionId={session.id} /> : undefined}
    />
  );
}
