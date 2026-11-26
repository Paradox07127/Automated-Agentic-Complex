import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse } from '../../src/bridge/protocol';
import { hotkeyLabels } from '../../src/domain/hotkeys';
import { NOW, WIRE_DELIVERIES, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { DLV_T1_V1, DLV_T1_V2 } from '../../src/mock/fixtures/ids';
import { Composer, type ComposerProps } from '../../src/pages/chat/Composer';
import { lookOffReason, useChatTasks } from '../../src/pages/chat/useChatData';
import { Processes } from '../../src/pages/diag/Processes';
import { processesOf } from '../../src/pages/diag/status';
import { paletteItems } from '../../src/shell/CmdPalette.data';
import { pageRoutes } from '../../src/shell/registry';
import { DEFAULT_PLUGINS } from '../../src/shell/plugins';
import { loadOverview } from './overviewReads';
import { pluginsOn, pluginsReset } from './plugins';

afterEach(() => {
  cleanup();
  pluginsReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

/** Fake bridge as `window.agenticComplex` whose agentd answers `override(path)` when it returns a response, recording every path. */
function install(override: (path: string) => AgentdResponse<unknown> | null = () => null) {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  const real = bridge.agentd.request.bind(bridge.agentd);
  const calls: string[] = [];
  vi.spyOn(bridge.agentd, 'connection').mockResolvedValue('connected');
  vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
    calls.push(path);
    return (override(path) ?? (await real(method, path, body))) as never;
  });
  window.agenticComplex = bridge;
  return { bridge, calls };
}

const wrapperOf = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };


describe('diag service rows', () => {
  it('shows the ssh and local services supervisor.state reports by name, without a restart', () => {
    const rows = processesOf(
      {
        agentd: { state: 'running', pid: 1 },
        avatar: { state: 'running', pid: 2 },
        llm: { state: 'backoff(4)', pid: null, backoff: 4 },
        tts: { state: 'running', pid: 3 },
      },
      'connected',
    );
    expect(rows.map((r) => r.key)).toEqual(['agentd', 'avatar', 'tts', 'llm']);
    const tts = rows.find((r) => r.key === 'tts');
    expect([tts?.name, tts?.status_text, tts?.restartable, tts?.pid]).toEqual(['语音服务', '运行中', false, 3]);
    const llm = rows.find((r) => r.key === 'llm');
    expect([llm?.name, llm?.status_text, llm?.backoff_s]).toEqual(['模型服务', '重启中', 4]);
    const { container } = render(
      <Processes rows={rows} error={null} onRetry={() => {}} samples={[]} now={0} metric="cpu" onMetric={() => {}} uptime={{}} agentdGone={false} actions={{}} highlight={null} onRestart={() => {}} onLogs={() => {}} />,
    );
    const restartIn = (key: string) => container.querySelector(`[data-nav-target="proc-${key}"]`)?.textContent?.includes('重启');
    expect(restartIn('tts')).toBe(false);
    expect(restartIn('avatar')).toBe(true);
  });

  // The voice is not a process: it is a 总览 row read from /diag/state.
  it('lists no service row when none runs under ssh or local, and no voice row', () => {
    const rows = processesOf({ agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 } }, 'connected');
    expect(rows.map((r) => r.key)).toEqual(['agentd', 'avatar']);
  });
});

describe('hotkey labels come from the saved settings', () => {
  it('keeps only the set combos', () => {
    expect(hotkeyLabels({ hk_quick: '⌃Space', hk_look: '', hk_hide: '⌃⌥H', web: true })).toEqual({ hk_quick: '⌃Space', hk_hide: '⌃⌥H' });
  });

  it('⌘K shows the saved quick-input and look keys, none when unset', () => {
    const quick = (keys: Parameters<typeof paletteItems>[4]) => paletteItems('', pageRoutes, undefined, {}, keys, { ...DEFAULT_PLUGINS, screen_reading: true }).filter((i) => i.key === 'quick-input' || i.key === 'look');
    expect(quick({ hk_quick: '⌃Space', hk_look: '⌥L' }).map((i) => i.shortcut)).toEqual(['⌃Space', '⌥L']);
    expect(quick({}).map((i) => i.shortcut)).toEqual([undefined, undefined]);
  });
});

describe('chat reads every page of the conversation’s tasks', () => {
  it('follows next_cursor', async () => {
    const [a, b] = WIRE_TASK_ROWS;
    const { calls } = install((path) => {
      if (!path.startsWith('/agent/tasks?')) return null;
      return path.includes('cursor=') ? { status: 200, body: { tasks: [b], next_cursor: null } } : { status: 200, body: { tasks: [a], next_cursor: 'p2' } };
    });
    const client = new QueryClient();
    pluginsOn('personal_agent');
    const { result } = renderHook(() => useChatTasks('conv-1', true), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.query.data?.base.tasks).toHaveLength(2);
    const reads = calls.filter((p) => p.startsWith('/agent/tasks?'));
    expect(reads).toHaveLength(2);
    expect(reads.every((p) => p.includes('conversation_id=conv-1'))).toBe(true);
    expect(reads[1]).toContain('cursor=p2');
    client.clear();
  });
});

describe('看一眼屏幕 needs screenshot sharing', () => {
  const props = (over: Partial<ComposerProps>): ComposerProps => ({
    roleName: '示例甲',
    history: false,
    busy: false,
    kernel: null,
    failed: null,
    sending: false,
    onSend: async () => 'sent' as const,
    onResend: () => {},
    onDiscardFailed: () => {},
    onContinue: () => {},
    onRecheck: () => {},
    ...over,
  });

  it('reads the reason from /capabilities share_screenshots', () => {
    expect(lookOffReason({ items: { share_screenshots: { state: 'unavailable', reason: 'off' } } })).toMatch(/截图/);
    expect(lookOffReason({ items: { share_screenshots: { state: 'configured', reason: null } } })).toBeNull();
    expect(lookOffReason(null)).toBeNull();
  });

  it('is disabled with its reason while sharing is off', () => {
    const onSend = vi.fn();
    render(<Composer {...props({ onSend, lookOff: '隐私里没开「看一下」时附上截图' })} />);
    fireEvent.click(screen.getByRole('button', { name: '附加' }));
    const look = screen.getByRole('menuitemcheckbox', { name: /^附带当前屏幕识读/ });
    expect(look.getAttribute('aria-disabled')).toBe('true');
    expect(look.getAttribute('title')).toBe('隐私里没开「看一下」时附上截图');
    fireEvent.click(look);
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '看看这个' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).toHaveBeenLastCalledWith('看看这个', { look: false, no_memory: false });
  });
});

describe('overview reviews list each task’s current version only', () => {
  it('drops an older undecided version', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const mock = createFakeBridge({ surface: 'main', still: true });
    const body = (await mock.agentd.request<Record<string, unknown>>('GET', '/agent/snapshot')).body!;
    const deliveries = WIRE_DELIVERIES.map((d) => (d.delivery_id === DLV_T1_V1 ? { ...d, state: 'presented', decided_at: null, decision_source: null } : d));
    install((path) => (path.startsWith('/agent/snapshot') ? { status: 200, body: { ...body, deliveries: { deliveries, next_cursor: null } } } : null));
    const s = await loadOverview(null, false);
    const reviews = s.pending.filter((p) => p.kind === 'review').map((p) => (p as { delivery_id: string }).delivery_id);
    expect(reviews).toContain(DLV_T1_V2);
    expect(reviews).not.toContain(DLV_T1_V1);
  });
});
