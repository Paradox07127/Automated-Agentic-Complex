// The desktop panels show 已关闭 / 未接入 the way the main window does: nothing hides, each says why and offers the fix.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, ComputerUsePanel, DesktopAnchor, DesktopCommand, DesktopState } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { ChipRoot } from '../../src/surfaces/desktop/ChipRoot';
import { ComputerUseRoot } from '../../src/surfaces/desktop/ComputerUseRoot';
import { ConsoleRoot } from '../../src/surfaces/desktop/ConsoleRoot';
import { dockItems } from '../../src/surfaces/desktop/DockRoot';
import { HudRoot } from '../../src/surfaces/desktop/HudRoot';
import { PowerMark, PowerState } from '../../src/ui/game';
import { stubMatchMedia } from './mediaStub';

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

const STATE: DesktopState = {
  hidden: false, clickThroughAll: false, freeRoam: false, quietUntil: null, dock: { open: true, side: 'right', compact: false },
  character: { id: 'voice_a', name: '示例甲' }, characters: [], screens: [],
  hotkeys: { hk_quick: '⌃Space', hk_ptt: '右 ⌥', hk_look: '⌃⌥L', hk_hide: '⌃⌥H' },
  pips: { agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 }, voice: 'on' },
  computerUseActive: false, plugins: ['light_ai', 'screen_reading'],
};

function stackBridge(): AgenticComplexBridge {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  return bridge;
}

describe('PowerState on the desktop panels', () => {
  it('hud marks the block, sizes its button md and keeps the content at full opacity', () => {
    render(
      <PowerState hud state="unlinked" mode="block" title="后台" reason="连不上" action={{ label: '重启后台', onClick: () => {} }}>
        <p>内容</p>
      </PowerState>,
    );
    const root = document.querySelector<HTMLElement>('[data-stub="PowerState"]')!;
    expect(root.hasAttribute('data-hud')).toBe(true);
    expect(within(screen.getByRole('status')).getByRole('button', { name: /重启后台/ }).className).toMatch(/md/);
  });

  it('PowerMark draws the same plug or ring with its word, the reason as its tip', () => {
    render(<PowerMark state="unlinked" reason="无响应" />);
    const mark = document.querySelector<HTMLElement>('[data-stub="PowerMark"]')!;
    expect(mark.textContent).toBe('未接入');
    expect(mark.getAttribute('title')).toBe('无响应');
    expect(mark.querySelector('svg')?.getAttribute('data-shape')).toBe('plug');
    cleanup();
    render(<PowerMark state="off" />);
    expect(document.querySelector('[data-stub="PowerMark"] svg')?.getAttribute('data-shape')).toBe('off');
  });
});

describe('her hover buttons', () => {
  it('keep 给她看 with 屏幕识读 off, greyed as 已关闭', () => {
    const look = dockItems({ ...STATE, plugins: ['light_ai'] }, null, null).find((i) => i.id === 'look');
    expect(look?.off).toMatch(/^已关闭：/);
  });

  it('say 未接入 while agentd is away, and name the microphone permission when it is denied', () => {
    const items = dockItems(STATE, { offline: true }, null);
    for (const id of ['chat', 'talk', 'look']) expect(items.find((i) => i.id === id)?.off).toBe('未接入：连不上后台');
    const talk = dockItems({ ...STATE, pips: { ...STATE.pips, voice: 'denied' } }, null, null).find((i) => i.id === 'talk');
    expect(talk?.off).toMatch(/^未接入：没有麦克风权限/);
  });
});

describe('控制台 offline', () => {
  function open() {
    const bridge = stackBridge();
    let send: (c: DesktopCommand) => void = () => {};
    let pushAnchor: (a: DesktopAnchor) => void = () => {};
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => ((send = cb), () => {}));
    vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => ((pushAnchor = cb), () => {}));
    const restart = vi.spyOn(bridge.supervisor, 'restart').mockResolvedValue();
    window.location.hash = '#/console?still=1&demo=console-offline';
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConsoleRoot />
      </QueryClientProvider>,
    );
    flush(() => pushAnchor({ panel: 'console', state: 'settled', side: 'status', docked: null, far: false, toHead: null, room: { width: 900, height: 820 } }));
    flush(() => send({ kind: 'openConsole' }));
    return restart;
  }

  it('shows 未接入 over her card with 重启后台, and the 后台 cell as the plug mark', async () => {
    const restart = open();
    const status = screen.getByRole('status', { name: '后台没有响应' });
    expect(status.textContent).toContain('未接入');
    await flush(async () => fireEvent.click(within(status).getByRole('button', { name: /重启后台/ })));
    expect(restart).toHaveBeenCalledWith('agentd');
    await waitFor(() => expect(screen.getByRole('group', { name: '组件状态' }).querySelector('[data-stub="PowerMark"]')).not.toBeNull());
    expect(screen.getByRole('group', { name: '组件状态' }).querySelector('[data-stub="PowerMark"]')?.closest('span[data-failed]')?.textContent).toContain('后台');
  });

  it('greys 快速输入 and 免打扰 as 未接入', () => {
    open();
    const quick = screen.getByRole('button', { name: '快速输入' });
    expect(quick.getAttribute('aria-disabled') ?? (quick as HTMLButtonElement).disabled.toString()).toBeTruthy();
    expect(quick.closest('[data-stub="WatchKey"]')?.textContent).toContain('未接入');
  });
});

describe('the status chip offline', () => {
  it('says 未接入 with the plug, and a click asks the shell to restart agentd', async () => {
    const bridge = stackBridge();
    window.location.hash = '#/chip';
    let presence: ((raw: unknown) => void) | null = null;
    let onAnchor: ((a: DesktopAnchor) => void) | null = null;
    vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => ((presence = cb), () => {}));
    vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => (queueMicrotask(() => cb({ ...STATE, dock: { open: false, side: 'right', compact: false } })), () => {}));
    vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => ((onAnchor = cb), () => {}));
    vi.spyOn(bridge.feed, 'subscribe').mockImplementation(() => () => {});
    vi.spyOn(bridge.stack, 'onCards').mockImplementation(() => () => {});
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    const restart = vi.spyOn(bridge.supervisor, 'restart').mockResolvedValue();
    render(<ChipRoot />);
    await flush(async () => {
      onAnchor?.({ panel: 'hud', state: 'settled', side: 'right', docked: null, far: false, toHead: { dx: -40, dy: 0 }, room: { width: 400, height: 400 } });
      presence?.({ offline: true });
    });
    const mark = document.querySelector('[data-chip="offline"] button')!;
    expect(mark.textContent).toBe('未接入');
    expect(mark.querySelector('svg')?.getAttribute('data-shape')).toBe('plug');
    fireEvent.click(mark);
    expect(restart).toHaveBeenCalledWith('agentd');
    expect(openMain).not.toHaveBeenCalled();
  });
});

describe('快速输入', () => {
  function mount(extra: { presence?: unknown; plugins?: DesktopState['plugins']; runtime?: unknown } = {}) {
    const bridge = stackBridge();
    vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => (queueMicrotask(() => cb({ ...STATE, plugins: extra.plugins ?? STATE.plugins })), () => {}));
    if (extra.presence) vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => (queueMicrotask(() => cb(extra.presence)), () => {}));
    if (extra.runtime) {
      const request = bridge.agentd.request.bind(bridge.agentd);
      vi.spyOn(bridge.agentd, 'request').mockImplementation(((method, path, body) =>
        path.startsWith('/character/runtime') ? Promise.resolve({ status: 200, body: extra.runtime }) : request(method, path, body)) as typeof request);
    }
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    const restart = vi.spyOn(bridge.supervisor, 'restart').mockResolvedValue();
    window.location.hash = '#/bubble?mode=input&still=1';
    render(<BubbleRoot />);
    return { openMain, restart };
  }

  it('opens as 未接入 while agentd is away, with 重启后台', async () => {
    const m = mount({ presence: { offline: true } });
    const status = await screen.findByRole('status', { name: '后台没有响应' });
    expect(status.textContent).toContain('未接入');
    fireEvent.click(within(status).getByRole('button', { name: /重启后台/ }));
    expect(m.restart).toHaveBeenCalledWith('agentd');
  });

  it('opens as 未接入 without a model, and the button opens the model account row', async () => {
    const m = mount({ runtime: { ready: false, error: 'native_login_required' } });
    const status = await screen.findByRole('status', { name: '没有可用的模型' });
    fireEvent.click(within(status).getByRole('button', { name: /前往设置连接/ }));
    expect(m.openMain).toHaveBeenCalledTimes(1);
    expect(m.openMain.mock.calls[0]![0]).toMatch(/^\/settings\?.*group=model.*item=svc/);
  });

  it('keeps 附上当前窗口 with 屏幕识读 off, as 已关闭, and a click opens its switch', async () => {
    const m = mount({ plugins: ['light_ai'] });
    const chip = await screen.findByRole('button', { name: /已关闭.*附上当前窗口/ });
    expect(chip.querySelector('[data-stub="PowerMark"] svg')?.getAttribute('data-shape')).toBe('off');
    fireEvent.click(chip);
    expect(m.openMain.mock.calls[0]![0]).toMatch(/^\/settings\?.*group=privacy.*item=plugins\.screen_reading/);
  });
});

describe('电脑操作 off', () => {
  it('reads 已关闭 and opens its switch in the main window', () => {
    const bridge = stackBridge();
    let push: (p: ComputerUsePanel) => void = () => {};
    vi.spyOn(bridge.computerUse, 'onPanel').mockImplementation((cb) => ((push = cb), () => {}));
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    render(<ComputerUseRoot />);
    flush(() => push({ phase: 'disabled', targetApp: null, action: '', scopeChips: [], permissions: {}, pendingGrants: [], showsPermissionChoices: false, canResume: false, challenge: '' }));
    const status = screen.getByRole('status', { name: '电脑操作' });
    expect(status.textContent).toContain('已关闭');
    fireEvent.click(within(status).getByRole('button', { name: /前往设置打开/ }));
    expect(openMain.mock.calls[0]![0]).toMatch(/^\/settings\?.*group=perm.*item=plugins\.computer_use/);
  });
});

describe('the status bar offline', () => {
  it('puts 未接入 with 重启后台 over its lines', async () => {
    const restart = vi.spyOn(getBridge().supervisor, 'restart').mockResolvedValue();
    window.location.hash = '#/hud?hud=three&offline=1&still=1';
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <HudRoot />
      </QueryClientProvider>,
    );
    const status = await screen.findByRole('status', { name: '后台没有响应' });
    expect(status.textContent).toContain('未接入');
    fireEvent.click(within(status).getByRole('button', { name: /重启后台/ }));
    expect(restart).toHaveBeenCalledWith('agentd');
  });
});
