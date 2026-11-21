import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse } from '../../src/bridge/protocol';
import { hotkeyLabels } from '../../src/domain/hotkeys';
import { NOW, WIRE_DELIVERIES, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { DLV_T1_V1, DLV_T1_V2, S_C07A } from '../../src/mock/fixtures/ids';
import { Composer, type ComposerProps } from '../../src/pages/chat/Composer';
import { lookOffReason, useChatTasks } from '../../src/pages/chat/useChatData';
import { Processes } from '../../src/pages/diag/Processes';
import { processesOf } from '../../src/pages/diag/status';
import { useSessionLines } from '../../src/pages/tasks/useTasksData';
import { paletteItems } from '../../src/shell/CmdPalette.data';
import { pageRoutes } from '../../src/shell/registry';
import type { Health } from '../../src/domain';
import { loadOverview } from './overviewReads';

afterEach(() => {
  cleanup();
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

const HEALTH = { voice: { state: 'ready' } } as unknown as Health;

describe('diag tunnel rows', () => {
  it('shows the voice and decision tunnels supervisor.state reports, without a restart', () => {
    const rows = processesOf(
      {
        agentd: { state: 'running', pid: 1 },
        avatar: { state: 'running', pid: 2 },
        tunnel: { state: 'running', pid: 3 },
      },
      'connected',
      HEALTH,
      null,
    );
    const tunnel = rows.find((r) => r.key === 'tunnel');
    expect([tunnel?.name, tunnel?.status_text, tunnel?.restartable, tunnel?.pid]).toEqual(['语音隧道', '运行中', false, 3]);
    const { container } = render(<Processes q={{ status: 'success', data: rows }} uptime={{}} history={null} actions={{}} highlight={null} onRestart={() => {}} onLogs={() => {}} onVoice={() => {}} />);
    const restartIn = (key: string) => container.querySelector(`[data-nav-target="proc-${key}"]`)?.textContent?.includes('重启');
    expect(restartIn('tunnel')).toBe(false);
    expect(restartIn('avatar')).toBe(true);
  });

  it('lists no tunnel row when none is configured', () => {
    const rows = processesOf({ agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 } }, 'connected', HEALTH, null);
    expect(rows.map((r) => r.key)).toEqual(['agentd', 'avatar', 'voice']);
  });

  it('shows an unknown voice as not checked yet', () => {
    const rows = processesOf({ agentd: { state: 'running', pid: 1 } }, 'connected', { voice: { state: 'unknown' } } as unknown as Health, null);
    const voice = rows.find((r) => r.key === 'voice');
    expect([voice?.status_text, voice?.tone]).toEqual(['未检测', 'idle']);
  });
});

describe('hotkey labels come from the saved settings', () => {
  it('keeps only the set combos', () => {
    expect(hotkeyLabels({ hk_quick: '⌃Space', hk_look: '', hk_hide: '⌃⌥H', web: true })).toEqual({ hk_quick: '⌃Space', hk_hide: '⌃⌥H' });
  });

  it('⌘K shows the saved quick-input and look keys, none when unset', () => {
    const quick = (keys: Parameters<typeof paletteItems>[4]) => paletteItems('', pageRoutes, undefined, {}, keys).filter((i) => i.key === 'quick-input' || i.key === 'look');
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
    const { result } = renderHook(() => useChatTasks('conv-1', true), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.base.tasks).toHaveLength(2);
    const reads = calls.filter((p) => p.startsWith('/agent/tasks?'));
    expect(reads).toHaveLength(2);
    expect(reads.every((p) => p.includes('conversation_id=conv-1'))).toBe(true);
    expect(reads[1]).toContain('cursor=p2');
    client.clear();
  });
});

describe('a running coding session’s lines are read incrementally', () => {
  it('asks for the lines after the last seq and appends them', async () => {
    vi.useFakeTimers();
    const { calls } = install();
    const client = new QueryClient();
    const { result } = renderHook(() => useSessionLines(S_C07A, 0), { wrapper: wrapperOf(client) });
    await act(() => vi.advanceTimersByTimeAsync(100));
    const first = result.current.data ?? [];
    expect(first.length).toBeGreaterThan(0);
    await act(() => vi.advanceTimersByTimeAsync(3100));
    const reads = calls.filter((p) => p.startsWith(`/sessions/${S_C07A}/lines`));
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.at(-1)).toContain(`after=${first.length}`);
    expect(result.current.data).toEqual(first);
    client.clear();
  });
});

describe('附加窗口 needs screenshot sharing', () => {
  const props = (over: Partial<ComposerProps>): ComposerProps => ({
    roleName: '示例甲',
    history: false,
    busy: false,
    kernel: null,
    alternative: null,
    failed: null,
    sending: false,
    onSend: () => {},
    onResend: () => {},
    onDiscardFailed: () => {},
    onContinue: () => {},
    onRecheck: () => {},
    onCopy: () => {},
    onSwitchKernel: () => {},
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
    const look = screen.getByRole('button', { name: '附加窗口' });
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
