// A handler that fails inside agentd answers 500 internal_error: the page says which call failed, never「后台已断开」.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { AgentdCallError } from '../../src/bridge/agentd';
import { codeText, failureText } from '../../src/domain/errorText';
import { failure as characterFailure } from '../../src/pages/character/api';
import { reasonOf as chatReason } from '../../src/pages/chat/reasons';
import { reasonOf as diagReason } from '../../src/pages/diag/reason';
import { errorText as memoryText } from '../../src/pages/memory/errors';
import { errorText as observeText } from '../../src/pages/observe/data';
import { errText as overviewText } from '../../src/pages/overview/errors';
import { failure as settingsFailure } from '../../src/pages/settings/api';
import { failMessage as tasksText } from '../../src/pages/tasks/actions';
import { look } from '../../src/shell/desktopOps';
import { toast } from '../../src/shell/toast';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
beforeEach(() => vi.mocked(toast).mockClear());

const ROUTE = 'GET /task-understanding';
const fault = () => new AgentdCallError(500, 'internal_error', undefined, { error: 'internal_error', route: ROUTE }, 'internal_error');
const bare = (status: number) => new AgentdCallError(status, `http_${status}`, undefined, null, `HTTP ${status}`);

describe('agentd 5xx is a fault, not a disconnect', () => {
  it('the shared sentence names the route agentd reports', () => {
    expect(failureText(fault())).toEqual({ text: `后台出错：${ROUTE}`, code: null });
    expect(failureText({ status: 502, code: 'http_502' }).text).toBe('后台出错（502）');
  });

  it('every page reason says 后台出错 with the route', () => {
    const texts = [
      characterFailure(fault()).text,
      chatReason(fault()),
      diagReason(fault()),
      memoryText(fault()),
      observeText(fault()),
      overviewText(fault()),
      settingsFailure(fault()).text,
      tasksText(fault()),
    ];
    for (const text of texts) expect(text).toBe(`后台出错：${ROUTE}`);
    expect(characterFailure(fault()).kind).toBe('other');
    expect(diagReason(bare(500))).toBe('后台出错（500）');
  });

  it('a 5xx with its own code keeps that code’s sentence', () => {
    expect(characterFailure(new AgentdCallError(503, 'no_tasks', undefined, null, 'no_tasks')).text).not.toContain('后台出错');
    expect(failureText({ status: 503, code: 'resetting' }).text).toBe('后台正在重置，请稍后重试');
  });

  it('屏幕识读 names POST /look when agentd failed on it', async () => {
    vi.spyOn(getBridge().app, 'look').mockRejectedValueOnce({ code: 'failed', detail: 'POST /look status 500 internal_error' });
    await look();
    expect(vi.mocked(toast).mock.calls.map((c) => c[0])).toEqual(['屏幕识读没有完成：后台出错：POST /look']);
  });
});

describe('a character switch in progress', () => {
  const switching = () => new AgentdCallError(409, 'switching', undefined, { error: 'switching' }, 'switching');

  it('says so on every page instead of 已在别处更新', () => {
    expect(failureText({ status: 409, code: 'switching' }).text).toBe('正在换角色，稍后再试');
    const texts = [memoryText(switching()), overviewText(switching()), settingsFailure(switching()).text, tasksText(switching())];
    for (const text of texts) expect(text).toBe('正在换角色，稍后再试');
  });
});

describe('codes a new user meets first', () => {
  it('pi_connection_missing and no_character say what to do, not the fallback', () => {
    expect(codeText('pi_connection_missing')).not.toBeNull();
    expect(codeText('pi_connection_missing')).toContain('设置 › pi 账号与凭据');
    expect(codeText('pi_connection_missing')).toContain('API Key');
    expect(codeText('no_character')).not.toBeNull();
    expect(codeText('no_character')).toContain('角色库里没有角色');
    expect(codeText('no_character')).toContain('「导入角色」');
  });
});

describe('output_truncated', () => {
  it('names the output limit and what to do', () => {
    expect(codeText('output_truncated')).toBe('回复太长，被模型的输出上限截断了。让她分几段写，或换一个输出上限更大的模型');
  });
});
