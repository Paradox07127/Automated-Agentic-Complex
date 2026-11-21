import { activeRunOf, DELIVERIES, NOW, pick, TASKS } from '../../mock/fixtures';
import { DLV_T1_V2, T1 } from '../../mock/fixtures/ids';
import type { TaskDrawerProps } from './TaskDrawer';

const t1 = pick(TASKS, T1);
const t1d = DELIVERIES.filter((d) => d.task_id === T1);

export const TaskDrawerDemos: Array<{ name: string; props: TaskDrawerProps }> = [
  { name: 'review', props: { task: t1, effective: 'waiting', now: NOW, delivery: pick(DELIVERIES, DLV_T1_V2), deliveries: t1d, activeRun: activeRunOf(T1), canReveal: true, onOpenTask: () => {} } },
  { name: 'rejecting', props: { task: t1, effective: 'waiting', now: NOW, delivery: pick(DELIVERIES, DLV_T1_V2), deliveries: t1d, activeRun: activeRunOf(T1), rejecting: true, kernelName: 'Codex' } },
  { name: 'stopped', props: { task: t1, effective: 'waiting', now: NOW, delivery: pick(DELIVERIES, DLV_T1_V2), deliveries: t1d, stoppedAt: NOW } },
];
