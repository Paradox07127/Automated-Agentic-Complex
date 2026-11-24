// Task view and receipt cache shared by the chat stream and drawer.
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Delivery, Plan } from '../../domain';
import { deriveView, type TasksLocal } from '../tasks/model';
import { useReceipts } from '../tasks/live';
import { usePlanSnapshot, type ChatTasks } from './useChatData';

export function useChatReceipts(data: ChatTasks | undefined, reload: () => void) {
  const qc = useQueryClient();
  return useReceipts(data?.base.deliveries ?? [], (d: Delivery) => {
    // A reply may land after a topic switch, or after a read that brought a newer (or redacted) revision.
    const newer = (x: Delivery) => x.id === d.id && d.revision > x.revision && !x.redacted;
    qc.setQueriesData<ChatTasks>({ queryKey: ['chat-tasks'] }, (data) => data ? { ...data, base: { ...data.base,
      deliveries: data.base.deliveries.map((x) => newer(x) ? d : x),
      tasks: data.base.tasks.map((t) => t.delivery && newer(t.delivery) ? { ...t, delivery: d, revision: d.revision } : t),
    } } : data);
  }, reload);
}

export function useChatTaskView(data: ChatTasks | undefined, local: TasksLocal, conv: string | null, plans: Readonly<Record<string, Plan>>, pickedTaskId: string | null) {
  const rawView = useMemo(() => (data ? deriveView(data.base, local) : null), [data, local]);
  const listedTasks = (rawView?.tasks ?? []).filter((t) => t.conversation_id != null && t.conversation_id === conv && t.source === 'role');
  const front = listedTasks.find((t) => rawView?.activeRuns[t.id] && !t.run_id?.startsWith('bg-')) ?? null;
  const defaultTask = front ?? listedTasks.find((t) => rawView?.activeRuns[t.id]) ?? [...listedTasks].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const selectedTask = listedTasks.find((t) => t.id === pickedTaskId) ?? defaultTask;
  const baseRun = selectedTask ? (rawView?.activeRuns[selectedTask.id] ?? null) : null;
  const snapshot = usePlanSnapshot(selectedTask?.run_id ?? null, baseRun != null);
  const livePlan = baseRun ? plans[baseRun.run_id] : undefined;
  const run = baseRun ? { ...baseRun, plan: livePlan ?? snapshot.data ?? null } : null;
  const plan = livePlan ?? snapshot.data;
  const view = rawView && plan && selectedTask ? { ...rawView, tasks: rawView.tasks.map((t) => t.id === selectedTask.id
    ? { ...t, steps: plan.steps, steps_done: plan.steps.filter((s) => s.status === 'completed').length, steps_total: plan.steps.length } : t) } : rawView;
  const convTasks = (view?.tasks ?? []).filter((t) => t.conversation_id === conv && t.source === 'role');
  const task = convTasks.find((t) => t.id === selectedTask?.id) ?? null;
  const headerRun = defaultTask ? (view?.activeRuns[defaultTask.id] ?? null) : null;
  return { view, convTasks, task, run, livePlan, defaultTask, headerRun: headerRun && headerRun.run_id === run?.run_id ? run : headerRun };
}
