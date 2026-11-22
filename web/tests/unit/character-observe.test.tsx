// 角色页观察模式（总览的「只看模型」）：舞台上拖动转她、滚轮和触控板捏合放大缩小，经 avatar.preview.view 交给外壳，一帧最多发一次；
// 进、出这一模式和换人都回到 turn 0、zoom 1。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { lastFakeView } from '../../src/bridge/fake/motion';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTIONS } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import { useObserve } from '../../src/pages/character/useObserve';
import { HeaderSlotContext } from '../../src/shell/headerSlot';

function Probe({ on, character = 'si' }: { on: boolean; character?: string }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useObserve(el, on, character);
  return <div ref={setEl} data-testid="stage" />;
}

let bridge: AgenticComplexBridge;
let view: MockInstance<AgenticComplexBridge['avatar']['preview']['view']>;
let frames: Map<number, FrameRequestCallback>;
let capture: ReturnType<typeof vi.fn>;

/** Runs the frames asked for so far. */
const flush = () =>
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(performance.now());
  });
const sent = () => view.mock.calls.map(([v]) => v);
const stage = () => screen.getByTestId('stage');
const drag = (el: HTMLElement, from: [number, number], ...to: [number, number][]) => {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
  for (const [x, y] of to) fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y });
};

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  view = vi.spyOn(bridge.avatar.preview, 'view');
  frames = new Map();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (frames.set(++id, cb), id));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((n) => void frames.delete(n));
  vi.stubGlobal('devicePixelRatio', 2);
  // jsdom has no pointer capture.
  capture = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: capture, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  delete window.agenticComplex;
});

describe('useObserve', () => {
  it('sends turn 0, zoom 1 on entering and on leaving, and on unmount while on', () => {
    const { rerender, unmount } = render(<Probe on={false} />);
    expect(view).not.toHaveBeenCalled();
    rerender(<Probe on />);
    expect(sent()).toEqual([{ turn: 0, zoom: 1 }]);
    expect(stage().dataset.observe).toBe('');
    drag(stage(), [100, 100], [140, 100]);
    flush();
    rerender(<Probe on={false} />);
    expect(sent().at(-1)).toEqual({ turn: 0, zoom: 1 });
    expect(lastFakeView()).toEqual({ turn: 0, zoom: 1 });
    expect(stage().dataset.observe).toBeUndefined();
    rerender(<Probe on />);
    view.mockClear();
    unmount();
    expect(sent()).toEqual([{ turn: 0, zoom: 1 }]);
  });

  it('turns her 0.5° per device pixel of horizontal drag; a vertical drag does nothing', () => {
    render(<Probe on />);
    const el = stage();
    drag(el, [100, 100], [150, 300], [200, 40]);
    expect(capture).toHaveBeenCalledWith(1);
    expect(el.dataset.grabbing).toBe('');
    flush();
    expect(sent().at(-1)).toEqual({ turn: 50 * devicePixelRatio, zoom: 1 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 200, clientY: 500 });
    flush();
    expect(view).toHaveBeenCalledTimes(2);
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 100, clientY: 500 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 100, clientY: 500 });
    expect(el.dataset.grabbing).toBeUndefined();
    flush();
    expect(sent().at(-1)).toEqual({ turn: 0, zoom: 1 });
    // Past the release the pointer turns nothing; no inertia.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 400, clientY: 500 });
    flush();
    expect(view).toHaveBeenCalledTimes(3);
    expect(lastFakeView()).toEqual({ turn: 0, zoom: 1 });
  });

  it('zooms 0.1 per 100 px of wheel, toward you out to 1, away closer to 0.3; a line counts 33 px', () => {
    render(<Probe on />);
    const el = stage();
    const zoom = () => sent().at(-1)!.zoom;
    fireEvent.wheel(el, { deltaY: -500, deltaMode: 0 });
    flush();
    expect(zoom()).toBeCloseTo(0.5);
    for (let i = 0; i < 3; i++) fireEvent.wheel(el, { deltaY: 100, deltaMode: 0 });
    flush();
    expect(zoom()).toBeCloseTo(0.8);
    for (let i = 0; i < 5; i++) fireEvent.wheel(el, { deltaY: 100, deltaMode: 0 });
    flush();
    expect(zoom()).toBe(1);
    fireEvent.wheel(el, { deltaY: -3, deltaMode: 1 });
    flush();
    expect(zoom()).toBeCloseTo(0.901);
    fireEvent.wheel(el, { deltaY: -10_000, deltaMode: 0 });
    flush();
    expect(zoom()).toBe(0.3);
    expect(lastFakeView()).toEqual({ turn: 0, zoom: 0.3 });
  });

  it('zooms by the trackpad pinch, Chromium\'s wheel with ctrlKey, within 0.3–1', () => {
    render(<Probe on />);
    const el = stage();
    expect(fireEvent.wheel(el, { deltaY: -50, ctrlKey: true })).toBe(false);
    flush();
    expect(sent().at(-1)!.zoom).toBeCloseTo(Math.exp(-0.5));
    fireEvent.wheel(el, { deltaY: 30, ctrlKey: true });
    flush();
    expect(sent().at(-1)!.zoom).toBeCloseTo(Math.exp(-0.2));
    fireEvent.wheel(el, { deltaY: 200, ctrlKey: true });
    flush();
    expect(sent().at(-1)!.zoom).toBe(1);
  });

  it('takes no gesture outside observe mode', () => {
    render(<Probe on={false} />);
    const el = stage();
    drag(el, [100, 100], [300, 100]);
    expect(fireEvent.wheel(el, { deltaY: 100 })).toBe(true);
    fireEvent.wheel(el, { deltaY: 50, ctrlKey: true });
    flush();
    expect(view).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(el.dataset.grabbing).toBeUndefined();
    expect(lastFakeView()).toBeNull();
  });

  it('sends at most one view a frame, the latest', () => {
    render(<Probe on />);
    const el = stage();
    view.mockClear();
    drag(el, [0, 0], [10, 0], [20, 0], [30, 0]);
    fireEvent.wheel(el, { deltaY: -100 });
    fireEvent.wheel(el, { deltaY: -100 });
    expect(view).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.turn).toBe(30);
    expect(sent()[0]!.zoom).toBeCloseTo(0.8);
  });

  it('a new character in observe mode keeps the mode and starts her at turn 0, zoom 1', () => {
    const { rerender } = render(<Probe on />);
    const el = stage();
    drag(el, [0, 0], [100, 0]);
    fireEvent.wheel(el, { deltaY: -300 });
    view.mockClear();
    rerender(<Probe on character="voice_a" />);
    expect(sent()).toEqual([{ turn: 0, zoom: 1 }]);
    // The frame asked for before the switch does not send her old view.
    flush();
    expect(sent()).toHaveLength(1);
    expect(el.dataset.observe).toBe('');
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 110, clientY: 0 });
    flush();
    expect(sent().at(-1)).toEqual({ turn: 0.5 * 10 * devicePixelRatio, zoom: 1 });
  });
});

describe('隐藏界面 is observe mode', () => {
  const props: OperatorProps = {
    roster: [
      { id: 'si', name: '示例乙', en: 'SI', active: true, appearances: [] },
      { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, appearances: [] },
    ],
    current: 'si',
    sw: { state: { phase: 'idle' }, request: () => {}, retry: () => {}, dismiss: () => {} },
    offline: false,
    backoff: null,
    onRestart: () => {},
    actions: MOTIONS,
    motionsError: null,
    onRetryMotions: () => {},
    charState: null,
    toast: () => {},
    pane: 'overview',
  };

  function inShell(p: OperatorProps) {
    const bottom = document.createElement('div');
    document.body.append(bottom);
    const node = (q: OperatorProps) => (
      <HeaderSlotContext.Provider value={{ setSub: () => {}, right: null, action: null, bottom }}>
        <Operator {...q} />
      </HeaderSlotContext.Provider>
    );
    const ui = render(node(p));
    return { bottom, ui, rerender: (q: OperatorProps) => ui.rerender(node(q)) };
  }
  const click = (el: Element) => act(async () => void fireEvent.click(el));
  const liveStage = (ui: ReturnType<typeof render>) => ui.container.querySelector<HTMLElement>('[data-preview-stage]')!;

  it('the key enters and leaves it; the stage takes the drag only in between', async () => {
    const { bottom, ui } = inShell(props);
    const el = liveStage(ui);
    drag(el, [0, 0], [100, 0]);
    flush();
    expect(view).not.toHaveBeenCalled();
    fireEvent.pointerUp(el, { pointerId: 1 });
    await click(screen.getByRole('button', { name: '隐藏界面' }));
    expect(sent()).toEqual([{ turn: 0, zoom: 1 }]);
    expect(el.dataset.observe).toBe('');
    drag(el, [0, 0], [100, 0]);
    flush();
    expect(sent().at(-1)).toEqual({ turn: 100, zoom: 1 });
    await click(screen.getByRole('button', { name: '隐藏界面', pressed: true }));
    expect(sent().at(-1)).toEqual({ turn: 0, zoom: 1 });
    expect(el.dataset.observe).toBeUndefined();
    bottom.remove();
  });

  it('a section change leaves it; a character switch keeps it and resets her view', async () => {
    const { bottom, ui, rerender } = inShell(props);
    await click(screen.getByRole('button', { name: '隐藏界面' }));
    const el = liveStage(ui);
    drag(el, [0, 0], [40, 0]);
    flush();
    view.mockClear();
    rerender({ ...props, current: 'voice_a' });
    expect(sent()).toEqual([{ turn: 0, zoom: 1 }]);
    expect(el.dataset.observe).toBe('');
    rerender({ ...props, current: 'voice_a', pane: 'motion' });
    expect(sent()).toEqual([{ turn: 0, zoom: 1 }, { turn: 0, zoom: 1 }]);
    expect(el.dataset.observe).toBeUndefined();
    bottom.remove();
  });
});
