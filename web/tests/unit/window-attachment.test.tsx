import { act as flush, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopCommand } from '../../src/bridge/protocol';
import { Attached } from '../../src/surfaces/desktop/cmd/input/Attached';
import { QuickInput } from '../../src/surfaces/desktop/cmd/input/QuickInput';
import { dropSay, stageDrop, useAttachment } from '../../src/surfaces/desktop/cmd/input/selection';

// The window she was dragged onto, which native sends just before 快速输入 opens, goes with the line as `lookWindow`.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  stageDrop(null);
  delete window.agenticComplex;
});

const WINDOW: Extract<DesktopCommand, { kind: 'window' }> = { kind: 'window', windowId: 77, pid: 123, app: '预览', title: 'a.pdf' };

function withCommands() {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  const listeners = new Set<(c: DesktopCommand) => void>();
  vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  });
  const send = async (...cs: DesktopCommand[]) => {
    for (const c of cs) await flush(async () => listeners.forEach((cb) => cb(c)));
  };
  return { bridge, send };
}

describe('window attachment', () => {
  it('dropSay looks at the window instead of attaching the current one', () => {
    const r = dropSay({ text: '这是什么', attachWindow: true, noMemory: false }, WINDOW);
    expect(r.lookWindow).toEqual({ windowId: 77, pid: 123 });
    expect(r.attachWindow).toBe(false);
    expect(r.text).toBe('这是什么');
  });

  it('a window command before an input open is the attachment and clears a staged drop', async () => {
    const { send } = withCommands();
    const { result } = renderHook(() => useAttachment());
    stageDrop([{ kind: 'url', url: 'https://example.com' }]);
    await send(WINDOW, { kind: 'open', mode: 'input' });
    expect(result.current).toEqual(WINDOW);
    await send({ kind: 'open', mode: 'input' });
    expect(result.current).toBeNull();
    await send(WINDOW, { kind: 'open', mode: 'ring' });
    expect(result.current).toBeNull();
  });

  it('Attached shows the app and title, without the title when there is none, and ✕ drops it', () => {
    const onDrop = vi.fn();
    render(<Attached attachment={WINDOW} sending={false} onDrop={onDrop} onSend={() => {}} />);
    expect(document.body.textContent).toContain('读这个窗口：预览 — a.pdf');
    fireEvent.click(screen.getByRole('button', { name: '不读这个窗口' }));
    expect(onDrop).toHaveBeenCalled();
    cleanup();
    render(<Attached attachment={{ ...WINDOW, title: null }} sending={false} onDrop={() => {}} onSend={() => {}} />);
    expect(document.body.textContent).toContain('读这个窗口：预览');
    expect(document.body.textContent).not.toContain(' — ');
    cleanup();
    render(<Attached attachment={{ ...WINDOW, app: null, title: null }} sending={false} onDrop={() => {}} onSend={() => {}} />);
    expect(document.body.textContent).toContain('读这个窗口');
    expect(document.body.textContent).not.toContain('：');
    cleanup();
    render(<Attached attachment={{ ...WINDOW, title: 'x'.repeat(41) }} sending={false} onDrop={() => {}} onSend={() => {}} />);
    expect(document.body.textContent).toContain(`预览 — ${'x'.repeat(40)}…`);
  });

  it('快速输入 with a window and nothing typed sends 看看这个窗口 with lookWindow, and 附上当前窗口 is off', async () => {
    const { bridge } = withCommands();
    const say = vi.spyOn(bridge.desktop, 'say');
    render(<QuickInput role="她" autoFocus={false} attachment={WINDOW} surface="quick_input" onClose={() => {}} />);
    const toggle = screen.getByRole('button', { name: '附上当前窗口' });
    expect(toggle).toHaveProperty('disabled', true);
    await flush(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({ text: '看看这个窗口', attachWindow: false, noMemory: false, lookWindow: { windowId: 77, pid: 123 }, surface: 'quick_input' });
  });
});
