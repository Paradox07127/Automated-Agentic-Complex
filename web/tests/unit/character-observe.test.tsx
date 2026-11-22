// 角色页检查镜头：每个分区都能在她身上拖动转向（左键）、平移（右键、中键、Shift + 左键）、滚轮和触控板捏合在指针处放大，经
// avatar.preview.view 交给外壳，一帧最多发一次，带上舞台在预览层里的位置（frame）；跨分区保留，换人和离开角色页回正；镜头回正键。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { lastFakeView } from '../../src/bridge/fake/motion';
import type { AgenticComplexBridge, PreviewView } from '../../src/bridge/protocol';
import { MOTIONS } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import { useInspect } from '../../src/pages/character/useInspect';
import { HeaderSlotContext } from '../../src/shell/headerSlot';

type Box = { left: number; top: number; width: number; height: number };
const rect = ({ left, top, width, height }: Box) =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

/** The stage 600 × 400 at (100, 0) in a 1000 × 800 layer at the origin. */
let stageBox: Box;
const LAYER: Box = { left: 0, top: 0, width: 1000, height: 800 };
const DEFAULT = { turn: 0, tilt: 0, zoom: 1, pan: [0, 0] };

function Probe({ character = 'si' }: { character?: string }) {
  const [grip, setGrip] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const v = useInspect(grip, stage, character);
  return (
    <>
      <div data-preview-layer="" data-testid="layer" />
      <div ref={setGrip} data-testid="grip" />
      <div ref={setStage} data-testid="stage" data-moved={v.moved || undefined} />
    </>
  );
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
const last = () => sent().at(-1)!;
const camera = (v: PreviewView | undefined) => v && { turn: v.turn, tilt: v.tilt, zoom: v.zoom, pan: v.pan };
const grip = () => screen.getByTestId('grip');
const drag = (el: HTMLElement, from: [number, number], to: [number, number][], init: { button?: number; shiftKey?: boolean } = {}) => {
  fireEvent.pointerDown(el, { pointerId: 1, button: init.button ?? 0, shiftKey: init.shiftKey ?? false, clientX: from[0], clientY: from[1] });
  for (const [x, y] of to) fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y });
};
const release = (el: HTMLElement) => fireEvent.pointerUp(el, { pointerId: 1 });

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  view = vi.spyOn(bridge.avatar.preview, 'view');
  frames = new Map();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (frames.set(++id, cb), id));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((n) => void frames.delete(n));
  vi.stubGlobal('devicePixelRatio', 2);
  stageBox = { left: 100, top: 0, width: 600, height: 400 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'stage' || this.hasAttribute('data-preview-stage')) return rect(stageBox);
    if (this.hasAttribute('data-preview-layer')) return rect(LAYER);
    return rect({ left: 0, top: 0, width: 0, height: 0 });
  });
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

describe('useInspect', () => {
  it('starts at the default view with the stage\'s place in the layer as the frame', () => {
    render(<Probe />);
    expect(sent()).toEqual([{ ...DEFAULT, frame: [0.1, 0, 0.6, 0.5] }]);
    expect(lastFakeView()).toEqual({ ...DEFAULT, frame: [0.1, 0, 0.6, 0.5] });
    expect(screen.getByTestId('stage').dataset.moved).toBeUndefined();
  });

  it('a left drag of (100, 40) px turns 50 × dpr and tilts 20 × dpr, with pointer capture and no inertia', () => {
    render(<Probe />);
    const el = grip();
    drag(el, [100, 100], [[150, 120], [200, 140]]);
    expect(capture).toHaveBeenCalledWith(1);
    expect(el.dataset.grabbing).toBe('');
    flush();
    expect(camera(last())).toEqual({ turn: 50 * devicePixelRatio, tilt: 20 * devicePixelRatio, zoom: 1, pan: [0, 0] });
    expect(screen.getByTestId('stage').dataset.moved).toBe('true');
    release(el);
    expect(el.dataset.grabbing).toBeUndefined();
    const n = view.mock.calls.length;
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 400, clientY: 500 });
    flush();
    expect(view).toHaveBeenCalledTimes(n);
  });

  it('clamps the tilt to ±80 and turns past 360', () => {
    render(<Probe />);
    const el = grip();
    drag(el, [0, 0], [[400, 1000]]);
    flush();
    expect(last().tilt).toBe(80);
    expect(last().turn).toBe(400);
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 400, clientY: -1000 });
    flush();
    expect(last().tilt).toBe(-80);
  });

  it('pans with Shift + left, right or middle drag so the point under the pointer stays: one stage width is zoom fit widths', () => {
    render(<Probe />);
    const el = grip();
    drag(el, [100, 100], [[160, 140]], { shiftKey: true });
    flush();
    expect(camera(last())).toEqual({ turn: 0, tilt: 0, zoom: 1, pan: [-0.1, -0.1] });
    release(el);
    expect(fireEvent.contextMenu(el)).toBe(false);
    drag(el, [100, 100], [[40, 100]], { button: 2 });
    flush();
    expect(last().pan![0]).toBeCloseTo(0);
    release(el);
    // Zoomed in to half at the stage's centre (the pan stays), a stage width of drag moves half a fit width.
    fireEvent.wheel(el, { deltaY: Math.log(0.5) / 0.0015, clientX: 400, clientY: 200 });
    drag(el, [100, 100], [[700, 100]], { button: 1 });
    flush();
    expect(last().zoom).toBeCloseTo(0.5);
    expect(last().pan![0]).toBeCloseTo(-0.5);
    expect(last().pan![1]).toBeCloseTo(-0.1);
  });

  it('zooms at the pointer: a wheel at the stage\'s right edge keeps that point where it is', () => {
    render(<Probe />);
    const el = grip();
    expect(fireEvent.wheel(el, { deltaY: -100, deltaMode: 0, clientX: 700, clientY: 200 })).toBe(false);
    flush();
    const z = Math.exp(-100 * 0.0015);
    expect(last().zoom).toBeCloseTo(z);
    // q = (0.5, 0): pan += q × (zoom_old − zoom_new); the point at 0.5 stage widths right of centre shows the same fit point.
    expect(last().pan![0]).toBeCloseTo(0.5 * (1 - z));
    expect(last().pan![1]).toBeCloseTo(0);
    expect(last().pan![0] + 0.5 * last().zoom).toBeCloseTo(0.5);
    // A line counts 33 px.
    fireEvent.wheel(el, { deltaY: 3, deltaMode: 1, clientX: 400, clientY: 200 });
    flush();
    expect(last().zoom).toBeCloseTo(z * Math.exp(99 * 0.0015));
  });

  it('zooms by the trackpad pinch, Chromium\'s wheel with ctrlKey, and clamps the zoom to 0.1–2', () => {
    render(<Probe />);
    const el = grip();
    expect(fireEvent.wheel(el, { deltaY: -50, ctrlKey: true, clientX: 400, clientY: 200 })).toBe(false);
    flush();
    expect(last().zoom).toBeCloseTo(Math.exp(-0.5));
    fireEvent.wheel(el, { deltaY: -10_000, clientX: 400, clientY: 200 });
    flush();
    expect(last().zoom).toBe(0.1);
    fireEvent.wheel(el, { deltaY: 10_000, clientX: 400, clientY: 200 });
    flush();
    expect(last().zoom).toBe(2);
    expect(lastFakeView()?.zoom).toBe(2);
  });

  it('sends at most one view a frame, the latest', () => {
    render(<Probe />);
    const el = grip();
    view.mockClear();
    drag(el, [0, 0], [[10, 0], [20, 0], [30, 0]]);
    fireEvent.wheel(el, { deltaY: -100, clientX: 400, clientY: 200 });
    fireEvent.wheel(el, { deltaY: -100, clientX: 400, clientY: 200 });
    expect(view).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.turn).toBe(30);
    expect(sent()[0]!.zoom).toBeCloseTo(Math.exp(-0.3));
    // Nothing changed: the next frame sends nothing.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 30, clientY: 0 });
    flush();
    expect(sent()).toHaveLength(1);
  });

  it('sends the frame again on every frame of the stage\'s ease, and once more where it ends', () => {
    render(<Probe />);
    const stage = screen.getByTestId('stage');
    view.mockClear();
    act(() => void stage.dispatchEvent(Object.assign(new Event('transitionrun', { bubbles: true }), { propertyName: 'left' })));
    stageBox = { ...stageBox, left: 200 };
    flush();
    expect(last().frame).toEqual([0.2, 0, 0.6, 0.5]);
    stageBox = { left: 0, top: 0, width: 500, height: 400 };
    flush();
    expect(last().frame).toEqual([0, 0, 0.5, 0.5]);
    expect(frames.size).toBe(1);
    stageBox = { left: 0, top: 0, width: 400, height: 400 };
    act(() => void stage.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'left' })));
    flush();
    expect(last().frame).toEqual([0, 0, 0.4, 0.5]);
    expect(frames.size).toBe(0);
    // A window resize places it again.
    stageBox = { left: 0, top: 400, width: 400, height: 400 };
    act(() => void window.dispatchEvent(new Event('resize')));
    flush();
    expect(last().frame).toEqual([0, 0.5, 0.4, 0.5]);
    expect(sent()).toHaveLength(4);
  });

  it('a new character starts her at the default view; the frame asked for before does not send the old one; unmount resets', () => {
    const { rerender, unmount } = render(<Probe />);
    const el = grip();
    drag(el, [0, 0], [[100, 10]]);
    fireEvent.wheel(el, { deltaY: -300, clientX: 700, clientY: 0 });
    flush();
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 105, clientY: 10 });
    view.mockClear();
    rerender(<Probe character="voice_a" />);
    expect(sent()).toEqual([{ ...DEFAULT, frame: [0.1, 0, 0.6, 0.5] }]);
    flush();
    expect(sent()).toHaveLength(1);
    expect(screen.getByTestId('stage').dataset.moved).toBeUndefined();
    // The drag goes on from where the pointer is.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 115, clientY: 10 });
    flush();
    expect(camera(last())).toEqual({ turn: 10, tilt: 0, zoom: 1, pan: [0, 0] });
    view.mockClear();
    unmount();
    expect(sent().map(camera)).toEqual([DEFAULT]);
  });
});

describe('inspection on the character page', () => {
  const props: OperatorProps = {
    roster: [
      { id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: [] },
      { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, voice: true, appearances: [] },
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
    const qc = new QueryClient();
    const node = (q: OperatorProps) => (
      <QueryClientProvider client={qc}>
        <HeaderSlotContext.Provider value={{ setSub: () => {}, right: null, action: null, bottom }}>
          <Operator {...q} />
        </HeaderSlotContext.Provider>
      </QueryClientProvider>
    );
    const ui = render(node(p));
    return { ui, rerender: (q: OperatorProps) => ui.rerender(node(q)), done: () => bottom.remove() };
  }
  const gripOf = (ui: ReturnType<typeof render>) => ui.container.querySelector<HTMLElement>('[data-inspect]')!;
  const resetKey = () => screen.queryByRole('button', { name: '镜头回正' });

  it.each([
    ['动作', { pane: 'motion' as const }],
    ['设定', { side: { of: 'set' as const, tab: 'behavior' as const, tabs: ['behavior' as const], node: <div /> } }],
    ['总览 without 只看模型', {}],
  ])('takes the drag on %s', (_name, extra) => {
    const { ui, done } = inShell({ ...props, ...extra });
    const el = gripOf(ui);
    drag(el, [0, 0], [[100, 40]]);
    flush();
    expect(camera(last())).toEqual({ turn: 100, tilt: 40, zoom: 1, pan: [0, 0] });
    // Without a preview layer the stage is the whole placed rect.
    expect(last().frame).toEqual([0, 0, 1, 1]);
    done();
  });

  it('keeps the view from 总览 to 动作 and resets it on a character switch', () => {
    const { ui, rerender, done } = inShell(props);
    drag(gripOf(ui), [0, 0], [[40, 0]]);
    release(gripOf(ui));
    flush();
    view.mockClear();
    rerender({ ...props, pane: 'motion' });
    flush();
    expect(sent().every((v) => v.turn === 40)).toBe(true);
    drag(gripOf(ui), [0, 0], [[10, 0]]);
    flush();
    expect(last().turn).toBe(50);
    rerender({ ...props, pane: 'motion', current: 'voice_a' });
    expect(camera(last())).toEqual(DEFAULT);
    done();
  });

  it('shows 镜头回正 only off the default view; it resets the view, and stays in 只看模型', async () => {
    const { ui, done } = inShell(props);
    expect(resetKey()).toBeNull();
    fireEvent.wheel(gripOf(ui), { deltaY: -200, clientX: 400, clientY: 200 });
    flush();
    expect(resetKey()).not.toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: '隐藏界面' })));
    expect(resetKey()).not.toBeNull();
    view.mockClear();
    fireEvent.click(resetKey()!);
    flush();
    expect(sent().map(camera)).toEqual([DEFAULT]);
    expect(resetKey()).toBeNull();
    done();
  });
});
