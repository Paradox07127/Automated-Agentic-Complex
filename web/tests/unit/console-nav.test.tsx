import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopAnchor, DesktopCommand, AgenticComplexBridge } from '../../src/bridge/protocol';
import { ConsoleRoot } from '../../src/surfaces/desktop/ConsoleRoot';
import { stubMatchMedia } from './mediaStub';

// 控制台 on `stack.html#/console`, its own panel under the menu bar item.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

function stackBridge(): AgenticComplexBridge {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  return bridge;
}

function mount() {
  window.location.hash = '#/console?still=1';
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConsoleRoot />
    </QueryClientProvider>,
  );
}

describe('控制台 panel', () => {
  it('subscribes to native anchor liveness while closed and uses the reported screen room', () => {
    const bridge = stackBridge();
    const unsubscribe = vi.fn();
    let pushAnchor: (anchor: DesktopAnchor) => void = () => {};
    let send: (command: DesktopCommand) => void = () => {};
    const anchor = vi.spyOn(bridge.window, 'onAnchor').mockImplementation((receive) => {
      pushAnchor = receive;
      return unsubscribe;
    });
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((receive) => {
      send = receive;
      return () => {};
    });
    const { unmount } = mount();
    expect(screen.queryByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeNull();
    expect(anchor).toHaveBeenCalledTimes(1);
    flush(() => pushAnchor({ panel: 'console', state: 'settled', side: 'menubar', docked: null,
      far: false, toHead: null, room: { width: 900, height: 300 } }));
    flush(() => send({ kind: 'openConsole' }));
    const menu = screen.getByRole('dialog', { name: 'Agentic Complex 菜单' });
    expect(menu.style.maxHeight).toBe('288px');
    fireEvent.click(screen.getByRole('button', { name: '关闭菜单' }));
    expect(screen.queryByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeNull();
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('shows the console on its own open command only, and nothing after a close', () => {
    const bridge = stackBridge();
    let send: (c: DesktopCommand) => void = () => {};
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      send = cb;
      return () => {};
    });
    mount();
    const root = document.querySelector('[data-surface-root="console"]');
    expect(root?.children).toHaveLength(0);
    flush(() => send({ kind: 'open', mode: 'ring' }));
    expect(root?.children).toHaveLength(0);
    flush(() => send({ kind: 'openConsole' }));
    expect(screen.getByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeTruthy();
    flush(() => send({ kind: 'close' }));
    expect(root?.children).toHaveLength(0);
  });

  it('drops the card when native hides the panel, so a later resize cannot show it again', () => {
    const bridge = stackBridge();
    let send: (c: DesktopCommand) => void = () => {};
    let visible: (v: boolean) => void = () => {};
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      send = cb;
      return () => {};
    });
    vi.spyOn(bridge.window, 'onVisibility').mockImplementation((cb) => {
      visible = cb;
      return () => {};
    });
    mount();
    const root = document.querySelector('[data-surface-root="console"]');
    flush(() => send({ kind: 'openConsole' }));
    flush(() => visible(true));
    expect(screen.getByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeTruthy();
    // Native can close the panel without sending a command.
    flush(() => visible(false));
    expect(root?.children).toHaveLength(0);
    flush(() => send({ kind: 'openConsole' }));
    expect(screen.getByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeTruthy();
  });
});

describe('控制台 card parts', () => {
  function open(room: number, demo = '') {
    const bridge = stackBridge();
    let send: (c: DesktopCommand) => void = () => {};
    let pushAnchor: (a: DesktopAnchor) => void = () => {};
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => ((send = cb), () => {}));
    vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => ((pushAnchor = cb), () => {}));
    window.location.hash = `#/console?still=1${demo ? `&demo=${demo}` : ''}`;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConsoleRoot />
      </QueryClientProvider>,
    );
    flush(() => pushAnchor({ panel: 'console', state: 'settled', side: 'status', docked: null, far: false, toHead: null, room: { width: 900, height: room } }));
    flush(() => send({ kind: 'openConsole' }));
    return bridge;
  }

  it('her card keeps room for its three lines on a short screen too', () => {
    open(300);
    expect(screen.getByRole('dialog', { name: 'Agentic Complex 菜单' }).hasAttribute('data-tight')).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-stub="CharCard"]')?.style.height).toBe('66px');
  });

  it('the four keys are compact, 打开主窗口 has the focus, and 退出 is the exit key', () => {
    open(820);
    expect([...document.querySelectorAll('[data-stub="WatchKey"] button')].map((b) => b.hasAttribute('data-compact'))).toEqual([true, true, true, true]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /打开主窗口/ }));
    expect(screen.getByRole('button', { name: '退出' }).closest('[data-stub="ExitKey"]')).not.toBeNull();
  });

  it('the error bars carry their buttons and the second line themselves', () => {
    open(820, 'console-offline');
    const down = screen.getByRole('status', { name: '后台服务无响应' });
    expect(down.textContent).toContain('未接入');
    expect(within(down).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([expect.stringMatching(/^重启后台/)]);
    cleanup();
    open(820, 'console-config');
    const config = screen.getByRole('alert');
    expect(config.querySelector('[data-part="detail"]')?.textContent).toBe('配置文件第 12 行不是有效的 JSON');
    expect(within(config.querySelector('[data-part="actions"]') as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['打开设置', '查看诊断']);
  });
});

describe('控制台 page links', () => {
  it('open the main window and close the console', async () => {
    const bridge = stackBridge();
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    const close = vi.spyOn(bridge.window, 'close');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /打开主窗口/ }));
    expect(openMain).toHaveBeenCalledExactlyOnceWith('/home?still=1');
    expect(screen.queryByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the menu open on a failed quick input handoff and retries', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action')
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(undefined);
    const close = vi.spyOn(bridge.window, 'close');
    mount();
    const quick = await screen.findByRole('button', { name: /快速输入/ });
    fireEvent.click(quick);
    expect(await screen.findByText('未能打开快速输入，请重试。')).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    await flush(async () => fireEvent.click(quick));
    expect(action.mock.calls).toEqual([['quickInput'], ['quickInput']]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeNull();
  });

  it('asks once before 退出, and Escape takes the question back without closing the menu', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action').mockResolvedValue(undefined);
    let send: (c: DesktopCommand) => void = () => {};
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      send = cb;
      return () => {};
    });
    mount();
    flush(() => send({ kind: 'openConsole' }));
    fireEvent.click(await screen.findByRole('button', { name: '退出' }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '退出确认' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog', { name: '退出确认' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Agentic Complex 菜单' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '退出确认' })).getByRole('button', { name: '退出' }));
    expect(action).toHaveBeenCalledExactlyOnceWith('quit');
  });
});
