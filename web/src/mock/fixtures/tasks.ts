import type { FileEffect, Goal, Task, TaskKey } from '../../domain';
import { fromGoal, fromLedgerTask, fromTaskRow, mergeTasks } from '../../domain/adapt';
import { at } from './clock';
import { T1, T2, T3, T4, T6 } from './ids';
import { SESSIONS } from './sessions';
import { WIRE_TASK_RUNS } from './wire/runs';
import { WIRE_GOALS, WIRE_LEDGER, WIRE_TASK_ROWS } from './wire/work';

/**
 * What a page adds from `/feed` plan and job events and from the own session row (T2's start): agentd's task rows
 * carry no steps or failure text. The fixtures apply them so demos show a page that has been listening.
 */
const FEED: Partial<Record<TaskKey, Partial<Task>>> = {
  [T1]: {
    steps: [
      { text: '读取提交记录', status: 'completed', since: at(14, 14, 20), detail: 'git log，142 条' },
      { text: '按目录归到项目', status: 'completed', since: at(14, 16), detail: '4 个项目' },
      { text: '写入第一版（按日期）', status: 'completed', since: at(14, 19), detail: '已退回' },
      { text: '按项目重写为 v2', status: 'completed', since: at(14, 22, 20), detail: '2026-W44 周报.md' },
      { text: '生成提交统计表', status: 'in_progress', since: at(14, 26, 20) },
    ],
    steps_done: 4,
    steps_total: 5,
  },
  [T2]: { started_at: at(14, 20), steps_done: 4 },
  [T3]: {
    steps: [
      { text: '读取 10 月账单', status: 'completed', since: at(14, 26, 25) },
      { text: '按类别归类', status: 'completed', since: at(14, 28, 40) },
      { text: '汇总金额', status: 'in_progress', since: at(14, 30) },
      { text: '生成开销表', status: 'pending', since: null },
      { text: '自检', status: 'pending', since: null },
    ],
    steps_done: 2,
    steps_total: 5,
  },
  [T4]: {
    steps: [
      { text: '读取需求', status: 'completed', since: at(10, 40) },
      { text: '跑基准', status: 'completed', since: at(10, 40, 30) },
      { text: '写报告并自检', status: 'completed', since: at(10, 56, 30) },
    ],
    steps_done: 3,
    steps_total: 3,
  },
  [T6]: {
    steps: [
      { text: '读取需求', status: 'completed', since: at(10, 12) },
      { text: '下载索引', status: 'failed', since: at(10, 12, 15) },
    ],
    steps_done: 1,
    steps_total: 2,
    failure: { reason: '资料授权已撤销：~/Downloads 不在可读取的文件夹里', fix: '去权限与授权' },
  },
};

const runOf = (runId: string | null) => WIRE_TASK_RUNS.find((r) => r.run_id === runId);

/** Task list: `/agent/tasks` rows (with their `/tasks` ledger row), ledger-only rows, and one `ext:` row per external session. */
export const TASKS: Task[] = mergeTasks(
  WIRE_TASK_ROWS.map((r) => fromTaskRow(r, WIRE_LEDGER.find((l) => l.task_id === r.task_id), runOf(r.run_id))),
  WIRE_LEDGER.map(fromLedgerTask),
  SESSIONS,
).map((t) => ({ ...t, ...FEED[t.id] }));

export const GOALS: Goal[] = WIRE_GOALS.map((g) => fromGoal(g, TASKS));

/** File impact per task. Writes match the delivered artifacts. */
export const FILE_EFFECTS: Record<string, FileEffect[]> = {
  [T1]: [
    { path: '~/Documents/周报/2026-W44 周报.md', op: 'write', added: 86, removed: 0 },
    { path: '~/Documents/周报/项目分组明细.md', op: 'write', added: 143, removed: 0 },
    { path: '~/Documents/周报/模板.md', op: 'modify', added: 4, removed: 2 },
    { path: '~/Documents/周报/2026-W43 周报.md', op: 'read' },
    { path: '~/Endfield/app/CHANGELOG.md', op: 'read' },
    { path: '~/Endfield/agent/README.md', op: 'read' },
  ],
  [T4]: [
    { path: '~/Documents/报告/metal-bench-1029.md', op: 'write', added: 212, removed: 0 },
    { path: '~/Endfield/renderer/host/Package.swift', op: 'read' },
  ],
};
