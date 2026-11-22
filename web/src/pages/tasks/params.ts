/** 进行中 / 定时 / 已完成. */
export type TasksTab = 'run' | 'sched' | 'done';

/** What the editor opens on: a role task or coding session to dispatch now, or a new schedule. */
export type CreateKind = 'role' | 'code' | 'sched';

/** Page URL state (demo list in demos.ts). */
export interface TasksParams {
  tab: TasksTab | null;
  /** Task id (`job:` / `task:` …) or schedule id; picks its tab when `tab` is absent. */
  sel: string | null;
  /** Opens the editor once. */
  create: CreateKind | null;
}

const TABS: readonly string[] = ['run', 'sched', 'done'];
const KINDS: readonly string[] = ['role', 'code', 'sched'];

export function parseTasksParams(search: string): TasksParams {
  const q = new URLSearchParams(search);
  const tab = q.get('tab') ?? '';
  const create = q.get('create') ?? '';
  return {
    tab: TABS.includes(tab) ? (tab as TasksTab) : null,
    sel: q.get('sel'),
    create: KINDS.includes(create) ? (create as CreateKind) : null,
  };
}

export { navigate } from '../../shell/nav';
