// Runs, steps and run items as agentd sends them.
import type { WireRun, WireRunItem, WireStep } from '../../../domain/wire';
import { atS } from '../clock';
import * as id from '../ids';

const run = (run_id: string, task: boolean, generation: number, state: string, started_at: number, ended_at: number | null, conversation_id: string): WireRun => ({
  run_id,
  conversation_id,
  character_id: id.CHARACTER,
  generation,
  state,
  scope_id: null,
  task_id: task ? `character-${run_id}` : null,
  sdk_session_id: null,
  dependencies: [],
  result: null,
  started_at,
  ended_at,
});

/** Runs of role tasks; their times match the task, delivery, error and character-cause fixtures. */
export const WIRE_TASK_RUNS: WireRun[] = [
  run('run-0f11', true, 0, 'failed', atS(10, 12), atS(10, 15), id.C3),
  run('run-5b20', true, 0, 'completed', atS(10, 40), atS(10, 58), id.C4),
  run('run-71a2', true, 0, 'completed', atS(14, 14), atS(14, 20), id.C1),
  run('run-8d03', true, 1, 'running', atS(14, 22, 5), null, id.C1),
  run('run-9c1e', true, 0, 'running', atS(14, 26), null, id.C3),
];

/** Conversation-run factory for runs.ts (which spreads them over the morning). */
export const conversationRun = (run_id: string, conversation_id: string, started_at: number, ended_at: number, state: string): WireRun =>
  run(run_id, false, 0, state, started_at, ended_at, conversation_id);

const step = (run_id: string, generation: number, n: number, phase: string, name: string | null, at: number, status: string | null = phase): WireStep => ({
  step_id: `${run_id}:event:${n}`,
  run_id,
  generation,
  kind: 'lifecycle',
  status,
  phase,
  name,
  summary: name ?? phase,
  at,
});

/** `/agent/tasks/{id}/steps` per task (phase is the raw code; domain/adapt maps it onto the lanes). */
export const WIRE_STEPS: Record<string, WireStep[]> = {
  [id.T1]: [
    step('run-71a2', 0, 1, 'task_started', '读取需求', atS(14, 14)),
    step('run-71a2', 0, 2, 'running', '读取提交并归类', atS(14, 14, 20)),
    step('run-71a2', 0, 3, 'verifying', '自检第一版', atS(14, 19, 30)),
    step('run-71a2', 0, 4, 'completed', null, atS(14, 20)),
    step('run-8d03', 1, 1, 'task_started', '读取补充要求', atS(14, 22, 5)),
    step('run-8d03', 1, 2, 'running', '按项目重写', atS(14, 22, 20)),
    step('run-8d03', 1, 3, 'verifying', '自检 v2', atS(14, 25, 40)),
    step('run-8d03', 1, 4, 'running', '生成提交统计表', atS(14, 26, 20)),
  ],
  [id.T3]: [
    step('run-9c1e', 0, 1, 'task_started', '读取需求', atS(14, 26)),
    step('run-9c1e', 0, 2, 'running', '读取 10 月账单', atS(14, 26, 25)),
    step('run-9c1e', 0, 3, 'running', '按类别归类', atS(14, 28, 40)),
    step('run-9c1e', 0, 4, 'running', '汇总金额', atS(14, 30)),
  ],
  [id.T4]: [
    step('run-5b20', 0, 1, 'task_started', '读取需求', atS(10, 40)),
    step('run-5b20', 0, 2, 'running', '跑基准', atS(10, 40, 30)),
    step('run-5b20', 0, 3, 'verifying', '自检', atS(10, 57)),
    step('run-5b20', 0, 4, 'completed', null, atS(10, 58)),
  ],
  [id.T6]: [
    step('run-0f11', 0, 1, 'task_started', '读取需求', atS(10, 12)),
    step('run-0f11', 0, 2, 'running', '下载索引', atS(10, 12, 15)),
    step('run-0f11', 0, 3, 'failed', null, atS(10, 15)),
  ],
  [id.T8]: [],
};

let seq = 0;
const item = (run_id: string, name: string, status: string, created_at: number, updated_at: number | null): WireRunItem => ({
  run_id,
  item_id: `item-${++seq}`,
  seq,
  kind: 'tool_call',
  phase: 'tool',
  status,
  name,
  summary: null,
  text: '',
  parent_item_id: null,
  created_at,
  updated_at: updated_at ?? created_at,
  steps: null,
});

/** `/agent/runs/{id}/items` per run (created_at → updated_at is an estimate). */
export const WIRE_ITEMS: Record<string, WireRunItem[]> = {
  'run-71a2': [
    item('run-71a2', 'Bash · git log', 'completed', atS(14, 14, 25), atS(14, 14, 26)),
    item('run-71a2', '读取目录', 'completed', atS(14, 16, 10), atS(14, 16, 11)),
    item('run-71a2', 'Write · 周报.md', 'completed', atS(14, 19), atS(14, 19, 3)),
  ],
  'run-8d03': [
    item('run-8d03', 'Write · 2026-W44 周报.md', 'completed', atS(14, 25, 30), atS(14, 25, 33)),
    item('run-8d03', 'Read · 项目分组明细.md', 'completed', atS(14, 31), atS(14, 31, 2)),
    item('run-8d03', 'Bash · python 统计', 'in_progress', atS(14, 31, 30), null),
  ],
  'run-9c1e': [
    item('run-9c1e', 'Read · 账单 9 月.csv', 'completed', atS(14, 27), atS(14, 27, 1)),
    item('run-9c1e', 'Read · 账单 10 月.csv', 'completed', atS(14, 28, 30), atS(14, 28, 31)),
    item('run-9c1e', 'Bash · python 汇总', 'completed', atS(14, 30), atS(14, 30, 40)),
    item('run-9c1e', 'read_file', 'in_progress', atS(14, 31, 18), null),
  ],
  'run-5b20': [
    item('run-5b20', 'Bash · bench --metal', 'completed', atS(10, 41), atS(10, 52)),
    item('run-5b20', 'Write · metal-bench-1029.md', 'completed', atS(10, 56, 30), atS(10, 56, 32)),
  ],
  'run-0f11': [item('run-0f11', 'Bash · curl 索引', 'completed', atS(10, 12, 40), atS(10, 13, 10)), item('run-0f11', 'Read · ~/Downloads', 'failed', atS(10, 14, 50), atS(10, 15))],
};
