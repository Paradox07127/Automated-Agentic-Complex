import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act as flush, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(menu.style.maxHeight).toBe('256px');
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

describe('控制台 page links', () => {
  it('open the main window and close the console', async () => {
    const bridge = stackBridge();
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    const close = vi.spyOn(bridge.window, 'close');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '打开主窗口' }));
    expect(openMain).toHaveBeenCalledExactlyOnceWith('/overview?focus=page&still=1');
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

  it('shows a failed command ring handoff and keeps its entry available', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action').mockRejectedValue(new Error('unavailable'));
    const close = vi.spyOn(bridge.window, 'close');
    mount();
    const ring = await screen.findByRole('button', { name: /命令环/ });
    fireEvent.click(ring);
    expect(await screen.findByText('未能打开命令环，请重试。')).toBeTruthy();
    expect(action).toHaveBeenCalledExactlyOnceWith('cmdMode', 'ring');
    expect(close).not.toHaveBeenCalled();
    expect(ring.hasAttribute('disabled')).toBe(false);
  });
});
