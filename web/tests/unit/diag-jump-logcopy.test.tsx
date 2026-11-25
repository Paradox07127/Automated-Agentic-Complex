// 诊断: each problem with a known fix jumps to it; 日志 copies several picked lines as one issue-report text.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppInfo } from '../../src/bridge/appInfo';
import { createFakeBridge } from '../../src/bridge/fake';
import type { LogLine } from '../../src/bridge/logs';
import type { AgenticComplexBridge, AvatarDetails, ProcessState } from '../../src/bridge/protocol';
import { isoWithOffset } from '../../src/domain/units';
import { CAPABILITIES, DIAG_STATE } from '../../src/mock/diag';
import { FlowSection } from '../../src/pages/diag/FlowSection';
import { GatePanel } from '../../src/pages/diag/GatePanel';
import { NowPanel } from '../../src/pages/diag/NowPanel';
import { DiagPage } from '../../src/pages/diag/Page';
import { Resources } from '../../src/pages/diag/Resources';
import { issuesOf } from '../../src/pages/diag/status';
import { logReport } from '../../src/pages/trace/logReport';
import { pluginsOn, pluginsReset } from './plugins';

let clipboard: string[];

function install(opts: { sup?: Record<string, ProcessState>; gateOff?: boolean } = {}) {
  const routes = opts.gateOff ? [{ method: 'GET' as const, path: '/diag/state', handler: () => ({ status: 200, body: { ...DIAG_STATE, gate: { ...DIAG_STATE.gate, enabled: false } } }) }] : [];
  const fake = createFakeBridge({ surface: 'main', still: true, routes });
  const bridge: AgenticComplexBridge = {
    ...fake,
    supervisor: { ...fake.supervisor, state: async () => opts.sup ?? (await fake.supervisor.state()) },
    clipboard: { writeText: async (t) => void clipboard.push(t) },
  };
  window.agenticComplex = bridge;
}

function mount(search: string) {
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const row = (key: string) => waitFor(() => document.querySelector<HTMLElement>(`[data-nav-target="proc-${key}"]`) ?? Promise.reject(new Error(`no row ${key}`)));

beforeEach(() => {
  pluginsOn();
  clipboard = [];
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  pluginsReset();
  delete window.agenticComplex;
});

describe('诊断 jumps to where a problem is fixed', () => {
  it('a kernel that wants a login lands on the 登录 row, a compatible model with its service off on 模型服务', () => {
    const caps = { ...CAPABILITIES, items: { generation: { state: 'unavailable', reason: 'native_login_required' }, mouth: { state: 'unavailable', reason: 'llm_service_off' } } } as typeof CAPABILITIES;
    expect(issuesOf(caps).map((i) => [i.id, i.to])).toEqual([
      ['generation', { page: 'settings', group: 'kernel', item: 'kernelLogin' }],
      ['mouth', { page: 'settings', group: 'services', item: 'svc_llm' }],
    ]);
  });

  it('a failed service row on 总览 and on 进程 opens its row in 设置 › 服务', async () => {
    const sup = { agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 }, tts: { state: 'failed(exit 1)', pid: null } } as Record<string, ProcessState>;
    install({ sup });
    mount('');
    fireEvent.click(within(await row('tts')).getByRole('button', { name: '前往设置' }));
    expect(window.location.hash).toBe('#/settings?group=services&item=svc_tts&focus=set-svc_tts');
    cleanup();
    window.location.hash = '';
    mount('&tab=proc');
    fireEvent.click(within(await row('tts')).getByRole('button', { name: '前往设置' }));
    expect(window.location.hash).toBe('#/settings?group=services&item=svc_tts&focus=set-svc_tts');
    // A running process has nothing to fix there.
    expect(within(await row('agentd')).queryByRole('button', { name: '前往设置' })).toBeNull();
  });

  it('proactive speech switched off opens 会不会主动找你, from 总览 and from the gate panel', async () => {
    install({ gateOff: true });
    mount('');
    await waitFor(async () => expect((await row('gate')).textContent).toContain('主动发言已关'));
    fireEvent.click(within(await row('gate')).getByRole('button', { name: '前往设置' }));
    expect(window.location.hash).toBe('#/settings?group=speak&item=speakWhen&focus=set-speakWhen');
    cleanup();
    window.location.hash = '';
    render(<GatePanel cooldowns={[]} gate={{ ...DIAG_STATE.gate, enabled: false }} />);
    fireEvent.click(screen.getByRole('button', { name: '前往设置' }));
    expect(window.location.hash).toBe('#/settings?group=speak&item=speakWhen&focus=set-speakWhen');
  });

  it('a gone backend offers its log next to the restart', async () => {
    install();
    const base = window.agenticComplex!;
    window.agenticComplex = { ...base, agentd: { ...base.agentd, request: async () => ({ status: 0, body: null, error: { code: 'offline' } }) } };
    mount('');
    const bar = (await screen.findByText('后台服务无响应')).closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(bar).getByRole('button', { name: '日志' }));
    expect(window.location.hash).toBe('#/diag?tab=logs&src=agentd');
  });

  it('the last speech failure opens 设置 › 说话; the host’s last error opens the 角色 log', async () => {
    render(<NowPanel d={{ ...DIAG_STATE, mouth_voice: { ...DIAG_STATE.mouth_voice, speech_failed: { speech_id: 's1', at: isoWithOffset(AT), reason: 'unreachable' } } }} />);
    fireEvent.click(screen.getByRole('button', { name: '前往设置' }));
    expect(window.location.hash).toBe('#/settings?group=speak&item=tts&focus=set-tts');
    cleanup();
    let logs = 0;
    const base = await createFakeBridge({ surface: 'main', still: true }).avatar.details();
    const details: AvatarDetails = { ...base, pipeline: { ...base.pipeline!, error: 'device lost' } };
    render(<Resources samples={[]} renderWhy="" details={details} onProc={() => {}} onLogs={() => (logs += 1)} />);
    fireEvent.click(screen.getByRole('button', { name: '日志' }));
    expect(logs).toBe(1);
  });

  it('the voice node, waiting on an unreachable TTS, opens 设置 › 说话', () => {
    let voice = 0;
    const node = { id: 'tts' as const, label: '语音', xi: 0, yi: 0, stat: null, state: 'att' as const };
    const noop = () => {};
    render(
      <FlowSection nodes={[node]} edges={[]} loading={false} error={null} onRetry={noop} turns={0} fails={0} liveAt={null} live={null} dead={false} calm sel="tts" onPick={noop} onClear={noop} onStation={noop} failsOf={() => []} approvals={0} onTasks={noop} onTrace={noop} onChat={noop} onVoice={() => (voice += 1)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '前往设置' }));
    expect(voice).toBe(1);
  });
});

const INFO: AppInfo = { version: '1.4.0', buildGit: 'abc1234', os: 'macOS 26.1.0', loadAverage: 1, cores: 8, source: 'bundle', devCommit: '', devDirty: false, devUiHash: '', devAgentdHash: '', hookInstallSteps: [] };
const AT = Date.UTC(2026, 10, 23, 6, 2, 11, 123);
const line = (p: Partial<LogLine>): LogLine => ({ source: 'agentd', off: 0, at: AT, level: 'err', text: '', more: [], turn: null, ...p });

describe('日志 copy text', () => {
  it('a header with version, commit and OS, then one block per line with time, level, source, message, code and trace', () => {
    const text = logReport(
      [
        line({ text: 'model call failed code=rate_limited trace_id=9f3a77', turn: '9f3a77', more: ['Traceback (most recent call last):', '  TimeoutError'] }),
        line({ source: 'companion', off: 10, at: AT + 1000, level: 'warn', text: 'helper: hello timed out after 5s; retrying' }),
        line({ source: 'companion', off: 20, at: AT + 2000, level: 'warn', text: 'helper: hello timed out after 5s; retrying' }),
      ],
      INFO,
    );
    expect(text).toBe(
      [
        'Agentic Complex 1.4.0 │ abc1234 │ macOS 26.1.0',
        '日志 3 条',
        '',
        `#1 ${isoWithOffset(AT)} │ 错误 │ 后台服务 (agentd)`,
        'model call failed code=rate_limited trace_id=9f3a77',
        'Traceback (most recent call last):',
        '  TimeoutError',
        'code: rate_limited',
        'trace_id: 9f3a77',
        '',
        `#2 ${isoWithOffset(AT + 1000)} │ 警告 │ 应用宿主 (companion) │ ×2`,
        'helper: hello timed out after 5s; retrying',
      ].join('\n'),
    );
  });

  it('a dev build names its commit; without the bridge the header is only the count', () => {
    expect(logReport([line({ text: 'x', at: null })], { ...INFO, source: 'dev', devCommit: '09c8967d0a1b2c3d', devDirty: true }).split('\n').slice(0, 4)).toEqual([
      'Agentic Complex 1.4.0 │ dev 09c8967d0 dirty │ macOS 26.1.0',
      '日志 1 条',
      '',
      '#1 — │ 错误 │ 后台服务 (agentd)',
    ]);
    expect(logReport([line({ text: 'x' })], null).split('\n')[0]).toBe('日志 1 条');
  });

  it('click picks a line, Shift-click a range, ⌘A every shown line; ⌘C and 复制所选 copy them with the header', async () => {
    install();
    mount('&tab=logs');
    const log = await screen.findByRole('log', { name: '日志行' });
    await waitFor(() => expect(log.textContent).toContain('ritual settle failed'));
    const lines = () => [...log.querySelectorAll<HTMLElement>('[data-key]')];
    const picked = () => lines().filter((l) => l.hasAttribute('data-sel'));
    fireEvent.mouseDown(lines()[1]!);
    fireEvent.mouseDown(lines()[3]!, { shiftKey: true });
    expect(picked()).toHaveLength(3);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制所选 3 行' })));
    expect(clipboard[0]!.split('\n').slice(0, 2)).toEqual(['Agentic Complex 0.0.0-fake │ fake │ macOS 26.1.0', '日志 3 条']);
    expect(clipboard[0]!.match(/^#\d /gm)).toEqual(['#1 ', '#2 ', '#3 ']);
    await act(async () => fireEvent.keyDown(window, { key: 'a', metaKey: true }));
    expect(picked()).toHaveLength(lines().length);
    await act(async () => fireEvent.keyDown(window, { key: 'c', metaKey: true }));
    expect(clipboard[1]).toContain('agentd: ritual settle failed: TimeoutError');
    expect(clipboard[1]!.split('\n')[1]).toMatch(/^日志 \d+ 条$/);
  });
});
