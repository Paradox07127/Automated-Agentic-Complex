import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopState } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { QuickInputBox } from '../../src/surfaces/desktop/cmd/input/QuickInputBox';
import { stubMatchMedia } from './mediaStub';

// 快速输入 under the bubble names the push-to-talk key (`hotkeys.hk_ptt`) while push-to-talk is on (`pips.voice`), so a
// click on her can be answered by voice too.

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

async function mount(hotkeys: Record<string, string>, voice: DesktopState['pips']['voice'] = 'on') {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  vi.spyOn(bridge.desktop, 'onState').mockImplementation((cb) => {
    queueMicrotask(() => cb({ ...STATE, hotkeys, pips: { ...STATE.pips, voice } }));
    return () => {};
  });
  window.location.hash = '#/bubble?mode=input&still=1';
  render(<BubbleRoot />);
  return screen.findByRole('dialog', { name: '快速输入' });
}

describe('快速输入 voice hint', () => {
  it('shows 按住 <key> 语音输入 with a push-to-talk key', async () => {
    await mount({ hk_ptt: '右⌥', hk_quick: '⌃Space' });
    const hint = await screen.findByText('语音输入', { exact: false });
    expect(hint.textContent).toBe('按住右⌥语音输入');
    expect(hint.querySelector('kbd')?.textContent).toBe('右⌥');
  });

  it('shows nothing without one', async () => {
    const dialog = await mount({ hk_quick: '⌃Space' });
    expect(screen.queryByText(/按住/)).toBeNull();
    expect(Array.from(dialog.querySelectorAll('kbd'), (el) => el.textContent)).toEqual(['⌘2', '⏎']);
  });

  it('shows nothing while push-to-talk is off or the microphone is denied, though the key is saved', async () => {
    for (const voice of ['off', 'denied'] as const) {
      const dialog = await mount({ hk_ptt: '右⌥' }, voice);
      expect(screen.queryByText(/按住/)).toBeNull();
      expect(Array.from(dialog.querySelectorAll('kbd'), (el) => el.textContent)).toEqual(['⌘2', '⏎']);
      cleanup();
    }
  });
});

describe('快速输入 theme', () => {
  it('the box takes the page theme; the error rows stay a dark tips card', async () => {
    const dialog = await mount({});
    expect(dialog.closest('[data-theme]:not(html)')).toBeNull();
    cleanup();
    render(
      <QuickInputBox role="示例甲" text="" onText={() => {}} attach={false} noMemory={false} onAttach={() => {}} onNoMemory={() => {}}
        error={{ ok: false, reason: 'kernel' }} sending={false} onSend={() => {}} onClose={() => {}} onRestartBackend={() => {}}
        onRecheck={() => {}} onOpenChat={() => {}} />,
    );
    expect(screen.getByRole('dialog', { name: '快速输入' }).closest('[data-theme]:not(html)')).toBeNull();
    expect(screen.getByRole('alert').closest('[data-theme]')?.getAttribute('data-theme')).toBe('dark');
  });
});

describe('快速输入 field', () => {
  it('is the shared TextArea in its desktop look: ⏎ sends, ⇧⏎ and a composing ⏎ do not, esc closes', () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    render(
      <QuickInputBox role="示例甲" text="帮我看看" onText={() => {}} attach={false} noMemory={false} onNoMemory={() => {}}
        error={null} sending={false} onSend={onSend} onClose={onClose} onRestartBackend={() => {}} onRecheck={() => {}} onOpenChat={() => {}} />,
    );
    const ta = screen.getByRole('textbox', { name: '对 示例甲 说的话' });
    const field = ta.closest('[data-stub="TextArea"]');
    expect(field?.hasAttribute('data-hud')).toBe(true);
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(ta, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith({ text: '帮我看看', attachWindow: false, noMemory: false });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
