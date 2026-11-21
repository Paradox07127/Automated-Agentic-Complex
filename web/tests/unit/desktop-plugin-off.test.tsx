// The desktop panels offer a plug-in's entries only while the shell's `desktop.onState` lists it among `plugins`.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopState } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { ringItems } from '../../src/surfaces/desktop/cmd/actions';
import { CmdRoot } from '../../src/surfaces/desktop/CmdRoot';
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
  avatarHovered: false,
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
  render(hash.startsWith('#/bubble') ? <BubbleRoot /> : <CmdRoot />);
}

describe('屏幕识读 off', () => {
  it('the action table has no 屏幕识读, before the state comes too', () => {
    expect(ringItems(STATE).map((i) => i.id)).toEqual(['input', 'openStack', 'goChat', 'quiet', 'pass', 'hide', 'gift']);
    expect(ringItems(null).map((i) => i.id)).not.toContain('look');
    expect(ringItems({ ...STATE, plugins: ['light_ai', 'screen_reading'] }).map((i) => i.id)).toContain('look');
  });

  it('the opened ring shows no 屏幕识读', async () => {
    mount('#/cmd?still=1', STATE);
    const ring = await screen.findByRole('menu', { name: '指令环' });
    expect(within(ring).queryByRole('menuitem', { name: /^屏幕识读/ })).toBeNull();
    expect(within(ring).getAllByRole('menuitem')).toHaveLength(7);
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
