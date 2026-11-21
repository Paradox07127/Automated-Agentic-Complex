import type { ActiveRun } from '../../domain';
import { ACTIVE_RUNS } from './runs';

/** Fixture row by id; throws so a renamed fixture fails loudly in demos and tests. */
export function pick<T extends { id: string }>(list: readonly T[], id: string): T {
  const row = list.find((x) => x.id === id);
  if (!row) throw new Error(`fixture ${id} not found`);
  return row;
}

/** Live run of a task; throws when the task has none. */
export function activeRunOf(taskId: string): ActiveRun {
  const run = ACTIVE_RUNS[taskId];
  if (!run) throw new Error(`no active run for ${taskId}`);
  return run;
}
