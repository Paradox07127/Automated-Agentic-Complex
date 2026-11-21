import { effectiveState } from '../../domain';
import { ACTIVE_RUNS, GOALS, PENDING, pick, SESSIONS, TASKS } from '../../mock/fixtures';
import { G1, G2 } from '../../mock/fixtures/ids';
import type { JobCellsProps } from './JobCells';

const ctx = { activeRuns: ACTIVE_RUNS, sessions: SESSIONS, pending: PENDING };
const jobsOf = (goalId: string) => pick(GOALS, goalId).task_ids.map((id) => ({ task: pick(TASKS, id), effective: effectiveState(pick(TASKS, id), ctx) }));

export const JobCellsDemos: Array<{ name: string; props: JobCellsProps }> = [
  { name: 'active', props: { jobs: jobsOf(G1) } },
  { name: 'paused', props: { jobs: jobsOf(G2) } },
];
