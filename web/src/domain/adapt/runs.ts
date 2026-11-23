// agentd run rows → domain objects.
import { codeText } from '../errorText';
import type { RunPhase, RunState } from '../states';
import { secToMs, secToMsOrNull } from '../units';
import type { WireRun } from '../wire';
import type { ActiveRun, Run, Task } from '../work';

export function fromRun(w: WireRun): Run {
  return {
    run_id: w.run_id,
    task_id: w.task_id,
    conversation_id: w.conversation_id,
    generation: w.generation,
    started_at: secToMs(w.started_at),
    ended_at: secToMsOrNull(w.ended_at),
    state: w.state as RunState,
  };
}

/** Error codes a run ends with (runtime.py) that the user can act on. */
const RUN_ERROR: Readonly<Record<string, { reason: string; fix?: string }>> = {
  scope_revoked: { reason: '资料授权已撤销', fix: '去权限与授权' },
  timeout: { reason: '运行超时' },
  cancelled: { reason: '已取消' },
  interrupted: { reason: '后台重启时中断' },
  character_busy: { reason: '角色正忙' },
};

const record = (v: unknown): Record<string, unknown> | null => (v != null && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/** Why a failed run failed: a known code in words, else the backend's public message; null unless the run failed. */
export function runFailure(w: WireRun | undefined): { reason: string; fix?: string } | null {
  const result = record(w?.result);
  if (!w || w.state !== 'failed' || !result) return null;
  const code = typeof result.error === 'string' ? result.error : '';
  const failure = record(result.failure);
  const message = failure?.public_message;
  const known = RUN_ERROR[code];
  if (known) return known;
  if (code === 'api_error' && !codeText(typeof failure?.code === 'string' ? failure.code : null)) return { reason: codeText(code)! };
  return { reason: typeof message === 'string' ? message : code || '运行失败' };
}

const RUN_PHASE: Readonly<Record<string, RunPhase>> = {
  task_started: 'prepare',
  verifying: 'verify',
  waiting_user: 'awaiting',
  awaiting_approval: 'awaiting',
  tool_started: 'tool',
  tool_call: 'tool',
  tool_result: 'tool',
};

/** Live runs (running or waiting_user) keyed by the canonical id of the task row whose run_id they are (tk:86). */
export function indexActiveRuns(runs: readonly WireRun[], tasks: readonly Task[]): Record<string, ActiveRun> {
  const out: Record<string, ActiveRun> = {};
  for (const r of runs) {
    if (r.state !== 'running' && r.state !== 'waiting_user') continue;
    const task = tasks.find((t) => t.run_id === r.run_id);
    if (!task) continue;
    out[task.id] = {
      run_id: r.run_id,
      task_id: r.task_id,
      generation: r.generation,
      conversation_id: r.conversation_id,
      state: r.state as RunState,
      phase: RUN_PHASE[r.state] ?? null,
      started_at: secToMs(r.started_at),
      since: secToMs(r.state_since),
      plan: null,
    };
  }
  return out;
}
