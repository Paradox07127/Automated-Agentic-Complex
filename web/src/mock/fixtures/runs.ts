import type { ActiveRun, Run, StepEvent, TaskKey, ToolItem } from '../../domain';
import { fromRun, fromStep, fromToolItem, indexActiveRuns } from '../../domain/adapt';
import type { WireRun } from '../../domain/wire';
import { at, MINUTE, NOW, SECOND, seeded } from './clock';
import { C2, C3, S_3C77, S_41B0, S_5E10, S_9A41, S_C07A, S_D0C2, T1, T3 } from './ids';
import { TASKS } from './tasks';
import { conversationRun, WIRE_ITEMS, WIRE_STEPS, WIRE_TASK_RUNS } from './wire/runs';

/**
 * Conversation runs filling the morning. Durations are log-normal with two long tails, so they
 * show a spread instead of a dozen stacked values.
 */
function conversationRuns(count: number): WireRun[] {
  const rnd = seeded(29);
  const busy = WIRE_TASK_RUNS.map((r) => [r.started_at * SECOND, (r.ended_at ?? NOW / SECOND) * SECOND] as const);
  const out: WireRun[] = [];
  let t = at(8, 5);
  for (let i = 0; out.length < count; i++) {
    const z = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    let dur = Math.round(Math.min(900, Math.max(6, Math.exp(Math.log(80) + 0.9 * z)))) * SECOND;
    if (out.length === 17) dur = 1152 * SECOND;
    if (out.length === 31) dur = 1060 * SECOND;
    const clash = busy.find(([s, e]) => t < e + MINUTE && t + dur > s - MINUTE);
    if (clash) {
      t = clash[1] + 2 * MINUTE;
      continue;
    }
    out.push(conversationRun(`run-${(4096 + i * 37).toString(16)}`, out.length % 3 === 0 ? C3 : C2, t / SECOND, (t + dur) / SECOND, out.length === 20 ? 'cancelled' : 'completed'));
    t += dur + Math.round((1 + rnd() * 4) * MINUTE);
  }
  return out;
}

/** `GET /agent/runs`: exactly the 50 the backend returns, oldest first. */
export const WIRE_RUNS: WireRun[] = [...conversationRuns(45), ...WIRE_TASK_RUNS].sort((a, b) => a.started_at - b.started_at);

export const RUNS: Run[] = WIRE_RUNS.map(fromRun);

const planOf = (taskId: TaskKey) => {
  const t = TASKS.find((x) => x.id === taskId);
  return t && t.steps.length > 0 ? { revision: 2, steps: t.steps } : null;
};

/** What presence and `/feed` agent_run / plan events add to a live run: agentd's run rows carry no phase, tool or plan. */
const LIVE: Partial<Record<TaskKey, Partial<ActiveRun>>> = {
  [T1]: { state: 'running_tool', phase: 'tool', since: at(14, 31, 30), tool: 'Bash · python 统计', plan: planOf(T1) },
  [T3]: { state: 'running_tool', phase: 'tool', since: at(14, 31, 18), tool: 'read_file', plan: planOf(T3) },
};

/** Live runs by task id (`/agent/runs` running or waiting_user rows, joined to their task rows). */
export const ACTIVE_RUNS: Record<string, ActiveRun> = Object.fromEntries(
  Object.entries(indexActiveRuns(WIRE_RUNS, TASKS)).map(([k, r]) => [k, { ...r, ...LIVE[k as TaskKey] }]),
);

/** Step events per task (`/agent/tasks/{id}/steps`). */
export const STEP_EVENTS: Record<string, StepEvent[]> = Object.fromEntries(Object.entries(WIRE_STEPS).map(([k, v]) => [k, v.map(fromStep)]));

const runIdsOf = (taskId: string) => [...new Set((WIRE_STEPS[taskId] ?? []).flatMap((e) => (e.run_id ? [e.run_id] : [])))];

/** Tool calls per task: the items of every run in its steps (`/agent/runs/{id}/items`). */
export const TOOL_ITEMS: Record<string, ToolItem[]> = Object.fromEntries(
  Object.keys(WIRE_STEPS).map((k) => [k, runIdsOf(k).flatMap((r) => (WIRE_ITEMS[r] ?? []).flatMap((x) => fromToolItem(x) ?? []))]),
);

/** Coding lane (`/day/segments`); session ids match SESSIONS where still open. */
export const DAY_SEGMENTS = [
  {
    project: 'Endfield',
    agent: 'Codex',
    sessions: [
      { id: S_41B0, started_at: at(10, 5), ended_at: at(11, 40), agents_failed: 1, last_gate: 'fail' as const },
      { id: S_9A41, started_at: at(13, 32), ended_at: null, agents_failed: 0, last_gate: null },
      { id: S_C07A, started_at: at(14, 20), ended_at: null, agents_failed: 0, last_gate: null },
    ],
  },
  {
    project: 'Endfield',
    agent: 'Claude Code',
    sessions: [
      { id: S_3C77, started_at: at(12, 10), ended_at: at(12, 55), agents_failed: 0, last_gate: 'pass' as const },
      { id: S_5E10, started_at: at(13, 51), ended_at: null, agents_failed: 0, last_gate: null },
      { id: S_D0C2, started_at: at(14, 23), ended_at: null, agents_failed: 0, last_gate: null },
    ],
  },
];

/** Approval lane (`/trace/decisions?kind=approval`); every wait is within the 55 s window. */
export const APPROVAL_DECISIONS: Array<{ opened_at: number; duration_ms: number; decision: 'allow' | 'deny' | 'timeout' }> = [
  { opened_at: at(9, 40), duration_ms: 12_000, decision: 'allow' },
  { opened_at: at(10, 22), duration_ms: 31_000, decision: 'allow' },
  { opened_at: at(11, 5), duration_ms: 55_000, decision: 'timeout' },
  { opened_at: at(12, 30), duration_ms: 8_000, decision: 'deny' },
  { opened_at: at(13, 2), duration_ms: 22_000, decision: 'allow' },
  { opened_at: at(14, 2), duration_ms: 40_000, decision: 'allow' },
  { opened_at: at(14, 30), duration_ms: 18_000, decision: 'allow' },
];
