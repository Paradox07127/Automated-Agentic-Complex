import { effectiveState } from '../../domain';
import { ACTIVE_RUNS, DELIVERIES, FILE_EFFECTS, NOW, PENDING, pick, SESSIONS, STEP_EVENTS, TASKS, TOOL_ITEMS } from '../../mock/fixtures';
import { T1, T2, T3, T6 } from '../../mock/fixtures/ids';
import type { TaskDetailProps } from './TaskDetail';

const CTX = { activeRuns: ACTIVE_RUNS, sessions: SESSIONS, pending: PENDING };

function detailDemo(id: string): TaskDetailProps {
  const t = pick(TASKS, id);
  const sessionId = SESSIONS.find((s) => s.task_id === t.id)?.id ?? null;
  // Approvals carry no task_id; they reach their task through the session.
  const pending = PENDING.filter((p) => p.task_id === t.id || (p.kind === 'approval' && sessionId != null && p.session_id === sessionId));
  return { task: t, effective: effectiveState(t, CTX), now: NOW, deliveries: DELIVERIES.filter((d) => d.task_id === t.id), pending, activeRun: ACTIVE_RUNS[t.id] ?? null, steps: STEP_EVENTS[t.id] ?? [], tools: TOOL_ITEMS[t.id] ?? [], files: FILE_EFFECTS[t.id] ?? [], sessionId };
}

export const TaskDetailDemos: Array<{ name: string; props: TaskDetailProps }> = [
  { name: 'waiting', props: detailDemo(T2) },
  { name: 'review', props: detailDemo(T1) },
  { name: 'failed', props: detailDemo(T6) },
  { name: 'decide-fail', props: { ...detailDemo(T1), decideFail: 'delivery_scope_revoked' } },
  { name: 'stopped', props: { ...detailDemo(T3), stoppedAt: NOW } },
];
