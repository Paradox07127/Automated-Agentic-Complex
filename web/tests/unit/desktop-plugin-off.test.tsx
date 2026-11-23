// The desktop panels offer a plug-in's entries only while the shell's `desktop.onState` lists it among `plugins`.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopState } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { DockRoot, dockItems } from '../../src/surfaces/desktop/DockRoot';
import { stubMatchMedia } from './mediaStub';

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

const STATE: DesktopState = {
  hidden: false,
  clickThroughAll: false,
  freeRoam: false,
  quietUntil: null,
  dock: { open: false, side: 'right', compact: false },
  character: { id: 'voice_a', name: '示例甲' },
  characters: [{ id: 'voice_a', name: '示例甲' }],
  screens: [{ id: '1', name: '内建显示器', current: true }],
  hotkeys: {},
  pips: { agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 }, voice: 'on' },
  computerUseActive: false,
  plugins: ['light_ai'],
};

function mount(hash: string, state: DesktopState) {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => {
    queueMicrotask(() => cb(state));
    return () => {};
  });
  window.location.hash = hash;
  render(hash.startsWith('#/bubble') ? <BubbleRoot /> : <DockRoot />);
}

describe('屏幕识读 off', () => {
  it('her hover buttons have no 给她看, before the state comes too', () => {
    expect(dockItems(STATE, null, null).map((i) => i.id)).toEqual(['chat', 'talk', 'hide']);
    expect(dockItems(null, null, null).map((i) => i.id)).not.toContain('look');
    expect(dockItems({ ...STATE, plugins: ['light_ai', 'screen_reading'] }, null, null).map((i) => i.id)).toEqual(['chat', 'talk', 'look', 'hide']);
  });

  it('the open hover buttons show no 给她看', async () => {
    mount('#/dock?still=1', { ...STATE, dock: { open: true, side: 'right', compact: false } });
    const group = await screen.findByRole('group', { name: '她的按钮' });
    expect(within(group).queryByRole('button', { name: '给她看' })).toBeNull();
    expect(within(group).getAllByRole('button')).toHaveLength(3);
  });

  it('快速输入 offers no 附上当前窗口; with it on it does', async () => {
    mount('#/bubble?mode=input&still=1', STATE);
    const dialog = await screen.findByRole('dialog', { name: '快速输入' });
    expect(within(dialog).getByRole('button', { name: '这一轮不记' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '附上当前窗口' })).toBeNull();
    cleanup();
    mount('#/bubble?mode=input&still=1', { ...STATE, plugins: ['light_ai', 'screen_reading'] });
    await screen.findByRole('button', { name: '附上当前窗口' });
  });
});
