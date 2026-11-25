// A job the kernel cannot run says why: a 503 before it is queued, a failed run's reason, and the login command the kernel chain offers.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentdCallError } from '../../src/bridge/agentd';
import { fromRuntimePublic, runFailure } from '../../src/domain/adapt';
import { failureText } from '../../src/domain/errorText';
import type { WireRun } from '../../src/domain/wire/work';
import { KernelChain } from '../../src/features/kernel/KernelChain';
import { WIRE_RUNTIME } from '../../src/mock/fixtures';
import { failMessage } from '../../src/pages/tasks/actions';

afterEach(cleanup);

const run = (result: unknown): WireRun => ({
  run_id: 'bg-1',
  conversation_id: 'c1',
  character_id: 'one',
  generation: 0,
  state: 'failed',
  scope_id: null,
  task_id: null,
  sdk_session_id: null,
  dependencies: null,
  result,
  started_at: 1,
  ended_at: 2,
  state_since: 2,
});

describe('kernel failure text', () => {
  it('a job refused for a missing login says so at once', () => {
    expect(failureText({ status: 503, code: 'native_login_required' }).text).toBe('当前执行内核尚未登录');
    expect(failMessage(new AgentdCallError(503, 'native_login_required', undefined, { error: 'native_login_required', runtime: 'codex' }, 'native_login_required'))).toBe('当前执行内核尚未登录');
  });

  it('an unclassified api_error points at the kernel settings; a classified one keeps its reason', () => {
    const recheck = '执行内核调用失败，请在「设置 › 内核」重新检测';
    expect(runFailure(run({ error: 'api_error', failure: { code: 'unknown', public_message: '本次请求失败，请稍后再试。' } }))?.reason).toBe(recheck);
    expect(runFailure(run({ error: 'api_error' }))?.reason).toBe(recheck);
    expect(runFailure(run({ error: 'api_error', failure: { code: 'auth_expired', public_message: '登录已过期，请重新登录。' } }))?.reason).toBe('登录已过期，请重新登录。');
  });
});

describe('login command', () => {
  const signedOut = {
    ...WIRE_RUNTIME,
    installed_runtimes: WIRE_RUNTIME.installed_runtimes.map((r) => ({ ...r, authenticated: false })),
    selected_runtime: null,
  };

  it('fromRuntimePublic passes agentd’s login command through, null when absent', () => {
    const rows = fromRuntimePublic(signedOut).runtimes;
    expect(rows.map((r) => r.login_command)).toEqual(['/opt/homebrew/bin/codex login', null]);
  });

  it('the kernel chain shows it for a signed-out kernel', () => {
    const codex = fromRuntimePublic(signedOut).runtimes.find((r) => r.id === 'codex')!;
    render(<KernelChain runtime={codex} />);
    expect(screen.getByText('/opt/homebrew/bin/codex login')).toBeTruthy();
  });
});
