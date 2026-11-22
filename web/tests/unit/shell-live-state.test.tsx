// Shell and character page: live avatar state, 停止说话 in ⌘K, the computer-use banner and no window.onA11y on main.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarState, ComputerUseState, AgenticComplexBridge } from '../../src/bridge/protocol';
import { CHARACTER_LOOKS, NOW } from '../../src/mock/fixtures';
import { STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator } from '../../src/pages/character/Operator';
import { CmdPalette } from '../../src/shell/CmdPalette';
import { resetDesktopOff } from '../../src/shell/desktopOps';
import { Layout } from '../../src/shell/Layout';
import { pageRoutes } from '../../src/shell/registry';
import { toast as pushToast } from '../../src/shell/toast';
import { stubMatchMedia } from './mediaStub';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

const noop = () => {};
let bridge: AgenticComplexBridge;
const toasts = () => vi.mocked(pushToast).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.mocked(pushToast).mockClear();
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  resetDesktopOff();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const avatar = (over: Partial<AvatarState>): AvatarState => ({
  running: true, visible: true, scale: 1, clickThroughAll: false, speaking: false, characterId: 'si', appearanceId: 'daily', ...over,
});

describe('character look follows avatar.onState', () => {
  const characters = [{ id: 'si', name: '示例乙', en: 'SI', active: true, appearances: CHARACTER_LOOKS.si ?? [] }];
  const profile = () =>
    render(
      <Operator
        roster={characters}
        current="si"
        sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
        offline={false}
        backoff={null}
        onRestart={noop}
        actions={[]}
        motionsError={null}
        onRetryMotions={noop}
        charState={STATE_WITH_CAUSES}
        toast={noop}
        pane="look"
      />,
    );
  const look = () => within(screen.getByRole('group', { name: '外观' })).getByRole('button', { pressed: true }).textContent;

  it('moves the size slider and the look when the menu or the resize overlay changes them, and unsubscribes on unmount', async () => {
    let push: (s: AvatarState) => void = noop;
    const off = vi.fn();
    const onState = vi.spyOn(bridge.avatar, 'onState').mockImplementation((cb) => ((push = cb), off));
    const ui = profile();
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    act(() => push(avatar({ scale: 1.5, appearanceId: 'uniform' })));
    expect((screen.getByRole('slider', { name: '大小' }) as HTMLInputElement).value).toBe('150');
    expect(look()).toContain('制服');
    ui.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('keeps a pushed state when the first state() reply arrives after it', async () => {
    let push: (s: AvatarState) => void = noop;
    let reply: (s: AvatarState) => void = noop;
    vi.spyOn(bridge.avatar, 'state').mockImplementation(() => new Promise((resolve) => (reply = resolve)));
    const onState = vi.spyOn(bridge.avatar, 'onState').mockImplementation((cb) => ((push = cb), noop));
    profile();
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    act(() => push(avatar({ scale: 1.5, appearanceId: 'uniform' })));
    await act(async () => reply(avatar({ scale: 1, appearanceId: 'daily' })));
    expect((screen.getByRole('slider', { name: '大小' }) as HTMLInputElement).value).toBe('150');
    expect(look()).toContain('制服');
  });
});

describe('⌘K 停止说话', () => {
  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CmdPalette routes={pageRoutes} onClose={noop} />
      </QueryClientProvider>,
    );

  it('calls avatar.stopSpeech and says it stopped, or says why not in Chinese', async () => {
    const stop = vi.spyOn(bridge.avatar, 'stopSpeech').mockResolvedValueOnce().mockRejectedValueOnce({ code: 'failed', detail: '角色没有连上' });
    for (let i = 0; i < 2; i++) {
      const ui = mount();
      const option = within(screen.getByRole('listbox')).getByRole('option', { name: /停止说话/ });
      await act(async () => fireEvent.click(option));
      ui.unmount();
    }
    expect(stop).toHaveBeenCalledTimes(2);
    expect(toasts()).toEqual(['已停止说话', '没有停下：角色没有连上']);
  });
});

describe('main window shell', () => {
  async function mountLayout() {
    stubMatchMedia();
    const root = createRootRoute({ component: Layout });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole('navigation', { name: '主导航' });
  }

  it('does not subscribe to window.onA11y, which the main surface is not allowed', async () => {
    const a11y = vi.spyOn(bridge.window, 'onA11y');
    await mountLayout();
    expect(a11y).not.toHaveBeenCalled();
  });

  it('shows the computer-use banner only while a session observes or acts, with a stop button', async () => {
    let push: (s: ComputerUseState) => void = noop;
    vi.spyOn(bridge.computerUse, 'onState').mockImplementation((cb) => ((push = cb), noop));
    vi.spyOn(bridge.computerUse, 'state').mockResolvedValue({ granted: ['observation'], active: false });
    const stop = vi.spyOn(bridge.computerUse, 'stop').mockResolvedValue();
    // The native main window reports computerUse false too: the banner does not depend on that bit.
    expect(bridge.capabilities.computerUse).toBe(false);
    await mountLayout();
    expect(screen.queryByText('电脑操作进行中')).toBeNull();
    act(() => push({ granted: ['observation', 'control'], active: true }));
    const banner = (await screen.findByText('电脑操作进行中')).closest('[role="status"]') as HTMLElement;
    expect(banner.textContent).toContain('已允许：观察控件、执行操作');
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: '停止' })));
    expect(stop).toHaveBeenCalledTimes(1);
    act(() => push({ granted: ['observation', 'control'], active: false }));
    expect(screen.queryByText('电脑操作进行中')).toBeNull();
  });
});
