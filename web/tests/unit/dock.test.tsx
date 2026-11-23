import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, DesktopState } from '../../src/bridge/protocol';
import { navRoute } from '../../src/shell/nav';
import { DockRoot, TAP_MS } from '../../src/surfaces/desktop/DockRoot';
import { stubMatchMedia } from './mediaStub';

// Her hover buttons (`#/dock`): the rows with the user's hot keys, 说话 held or tapped, a pick through desktop.action.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function mount(state: DesktopState = STATE) {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  window.location.hash = '#/dock?still=1';
  let push: ((s: DesktopState) => void) | null = null;
  vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => ((push = cb), queueMicrotask(() => cb(state)), () => {}));
  const action = vi.spyOn(bridge.desktop, 'action').mockResolvedValue(undefined);
  const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
  render(<DockRoot />);
  return { action, openMain, state: (s: DesktopState) => flush(async () => push?.(s)) };
}

const group = () => screen.getByRole('group', { name: '她的按钮' });
const row = (name: RegExp) => within(group()).getByRole('button', { name });

describe('her hover buttons', () => {
  it('show 对话, 说话, 给她看 and 隐藏 with the saved keys while native has them open, and nothing while closed', async () => {
    const d = mount();
    await flush(async () => {});
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['对话', '说话', '给她看', '隐藏']);
    expect(group().textContent).toContain('⌃Space');
    expect(group().textContent).toContain('右 ⌥');
    expect(document.querySelector('[data-surface-root="dock"] [data-region]')).not.toBeNull();
    await d.state({ ...STATE, dock: { open: false, side: 'right', compact: false } });
    expect(screen.queryByRole('group', { name: '她的按钮' })).toBeNull();
    expect(document.querySelector('[data-surface-root="dock"] [data-region]')).toBeNull();
  });

  it('mirror on her left, and keep only the key blocks while she is small', async () => {
    const d = mount({ ...STATE, dock: { open: true, side: 'left', compact: false } });
    await flush(async () => {});
    expect(document.querySelector('[data-stub="OptionStack"]')?.getAttribute('data-side')).toBe('left');
    await d.state({ ...STATE, dock: { open: true, side: 'right', compact: true } });
    expect(document.querySelector('[data-stub="OptionStack"]')?.hasAttribute('data-compact')).toBe(true);
  });

  it('对话, 给她看 and 隐藏 go through desktop.action', async () => {
    const d = mount();
    await flush(async () => {});
    for (const name of [/^对话$/, /^给她看$/, /^隐藏$/]) await flush(async () => fireEvent.click(row(name)));
    expect(d.action.mock.calls).toEqual([['quickInput', undefined], ['look', undefined], ['hide', undefined]]);
  });

  it('说话 held records until the release; the row says so and the others go', async () => {
    const d = mount();
    await flush(async () => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    await flush(async () => fireEvent.pointerDown(row(/^说话$/), { button: 0, pointerId: 1 }));
    expect(d.action.mock.calls).toEqual([['talk', 'start']]);
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['在听…松开发送']);
    now.mockReturnValue(1000 + TAP_MS + 300);
    await flush(async () => fireEvent.pointerUp(row(/^在听/), { button: 0, pointerId: 1 }));
    await flush(async () => fireEvent.click(row(/^说话$/)));
    expect(d.action.mock.calls).toEqual([['talk', 'start'], ['talk', 'stop']]);
  });

  it('说话 tapped records until the next click', async () => {
    const d = mount();
    await flush(async () => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    await flush(async () => fireEvent.pointerDown(row(/^说话$/), { button: 0, pointerId: 1 }));
    now.mockReturnValue(1000 + TAP_MS - 50);
    await flush(async () => fireEvent.pointerUp(row(/^在听/), { button: 0, pointerId: 1 }));
    await flush(async () => fireEvent.click(row(/^在听/)));
    expect(row(/^在听/).getAttribute('aria-label')).toBe('在听…再点一下发送');
    expect(d.action.mock.calls).toEqual([['talk', 'start']]);
    await flush(async () => fireEvent.pointerDown(row(/^在听/), { button: 0, pointerId: 1 }));
    expect(d.action.mock.calls).toEqual([['talk', 'start'], ['talk', 'stop']]);
  });

  it('说话 held ends when the press is cancelled, as at its release', async () => {
    const d = mount();
    await flush(async () => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    await flush(async () => fireEvent.pointerDown(row(/^说话$/), { button: 0, pointerId: 1 }));
    now.mockReturnValue(1000 + TAP_MS + 300);
    await flush(async () => fireEvent.pointerCancel(row(/^在听/), { pointerId: 1 }));
    expect(d.action.mock.calls).toEqual([['talk', 'start'], ['talk', 'stop']]);
    expect(within(group()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['对话', '说话', '给她看', '隐藏']);
  });

  it('a press on 对话 records nothing; its click picks it', async () => {
    const d = mount();
    await flush(async () => {});
    await flush(async () => fireEvent.pointerDown(row(/^对话$/), { button: 0, pointerId: 1 }));
    await flush(async () => fireEvent.pointerUp(row(/^对话$/), { button: 0, pointerId: 1 }));
    await flush(async () => fireEvent.click(row(/^对话$/)));
    expect(d.action.mock.calls).toEqual([['quickInput', undefined]]);
  });

  it('without agentd 对话, 说话 and 给她看 are greyed with the reason, and a greyed 说话 records nothing', async () => {
    const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
    window.agenticComplex = bridge;
    vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => (queueMicrotask(() => cb(STATE)), () => {}));
    vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => (queueMicrotask(() => cb({ offline: true })), () => {}));
    const action = vi.spyOn(bridge.desktop, 'action').mockResolvedValue(undefined);
    render(<DockRoot />);
    await flush(async () => {});
    for (const name of [/^对话$/, /^说话$/, /^给她看$/]) expect(row(name).getAttribute('aria-disabled')).toBe('true');
    expect(row(/^说话$/).getAttribute('title')).toBe('未接入：连不上后台');
    await flush(async () => fireEvent.pointerDown(row(/^说话$/), { button: 0, pointerId: 1 }));
    expect(action).not.toHaveBeenCalled();
  });

  it('without the microphone 说话 is greyed, records nothing, and a click opens 设置 at the microphone permission', async () => {
    const d = mount({ ...STATE, pips: { ...STATE.pips, voice: 'denied' } });
    await flush(async () => {});
    expect(row(/^说话$/).getAttribute('aria-disabled')).toBe('true');
    await flush(async () => fireEvent.pointerDown(row(/^说话$/), { button: 0, pointerId: 1 }));
    await flush(async () => fireEvent.click(row(/^说话$/)));
    expect(d.action).not.toHaveBeenCalled();
    expect(d.openMain.mock.calls).toEqual([[navRoute({ page: 'settings', group: 'perm', item: 'microphone' })]]);
  });

  it('a greyed row for any other reason opens nothing', async () => {
    const d = mount({ ...STATE, plugins: ['light_ai'] });
    await flush(async () => {});
    await flush(async () => fireEvent.click(row(/^给她看$/)));
    expect(d.action).not.toHaveBeenCalled();
    expect(d.openMain).not.toHaveBeenCalled();
  });
});
