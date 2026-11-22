// Renders one task's detail as the tasks page draws it, over a view built from `base`; the desk's actions are real.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Task } from '../../src/domain';
import { NOW } from '../../src/mock/fixtures';
import { createTasksActions, type ActionDeps } from '../../src/pages/tasks/actions';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import { TaskDetail } from '../../src/pages/tasks/TaskDetail';
import type { TaskDesk } from '../../src/pages/tasks/useTaskDesk';
import type { TasksBase } from '../../src/pages/tasks/useTasksData';

export function mountTaskDetail(task: Task, base: Partial<TasksBase> = {}, local = emptyLocal()) {
  const view = deriveView({ tasks: [task], deliveries: [], sessions: [], approvals: [], questions: [], goals: [], activeRuns: {}, roleMissing: false, ...base }, local);
  const push = vi.fn();
  const deps: ActionDeps = { view, setLocal: vi.fn(), push, order: [], select: vi.fn(), failCode: null, setDecideFail: vi.fn(), setBusy: vi.fn(), askStop: vi.fn(), retrySteps: vi.fn(), reload: vi.fn(), now: () => NOW, nativeOff: vi.fn() };
  const desk = { view, actions: createTasksActions(deps), local, receipt: vi.fn(), kernel: { data: '默认内核' }, now: NOW, push, retry: 0, busy: false, decideFail: null, nativeOff: {} } as unknown as TaskDesk;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={client}>
      <TaskDetail task={view.tasks.find((t) => t.id === task.id) ?? task} desk={desk} who="陈千语" convTitle={() => null} onGoChat={() => {}} note={false} onNote={() => {}} />
    </QueryClientProvider>,
  );
  return { ...r, deps };
}
