import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Region } from '../../src/bridge';
import type { ResizeOverlayState } from '../../src/bridge/resize';
import { createFakeBridge } from '../../src/bridge/fake';
import { ResizeRoot } from '../../src/surfaces/desktop/ResizeRoot';
import { percentText, resizeLayout, rulerPosition } from '../../src/surfaces/desktop/resizeLayout';

// `stack.html#/resize`: the brackets, the four handles on her
// corners, the percentage chip, the 恢复默认 / 完成 bar and where the bar and the chip go.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

/** AvatarLayerTests: a 1440 × 875 visible frame, her size at 100 % 120 × 200; here y down. */
const PAGE = { width: 1440, height: 875 };
const base = { width: 120, height: 200 };
/** Roughly the bar (恢复默认 and 完成 in 13 pt, 6 pt padding) and chip sizes. */
const BAR = { width: 162, height: 40 };
const CHIP = { width: 134, height: 22 };
const frame = (scale: number, x = 700, top = 375): Region => ({ x, y: top, width: base.width * scale, height: base.height * scale });
const intersects = (a: Region, b: Region) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (r: Region) => r.x >= 0 && r.y >= 0 && r.x + r.width <= PAGE.width && r.y + r.height <= PAGE.height;
const grown = (r: Region, d: number) => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });

describe('AvatarResizeLayout', () => {
  it('testExitReachableAtLimits: at 50 % and 200 % in the top-left and bottom-right corners the bar stays on screen, clear of her', () => {
    for (const scale of [0.5, 2]) {
      const w = base.width * scale, h = base.height * scale;
      for (const [avatar, corner] of [[{ x: 0, y: 0, width: w, height: h }, 'bottomRight'],
        [{ x: PAGE.width - w, y: PAGE.height - h, width: w, height: h }, 'bottomLeft']] as const) {
        const layout = resizeLayout(avatar, PAGE, CHIP, BAR);
        expect(layout.barCorner, `scale ${scale}`).toBe(corner);
        expect(inside(layout.bar)).toBe(true);
        expect(intersects(layout.bar, grown(avatar, 8))).toBe(false);
        expect(inside(layout.chip)).toBe(true);
        expect(intersects(layout.bar, layout.chip)).toBe(false);
      }
    }
  });

  it('testBarPositionRule: bottom-right by default, under the menu bar when she spans the bottom, on screen when she is bigger', () => {
    const middle = resizeLayout(frame(1), PAGE, CHIP, BAR);
    expect(middle.barCorner).toBe('bottomRight');
    expect(middle.bar).toEqual({ x: PAGE.width - 12 - BAR.width, y: PAGE.height - 14 - BAR.height, ...BAR });
    const top = resizeLayout({ x: 0, y: PAGE.height - 300, width: PAGE.width, height: 300 }, PAGE, CHIP, BAR);
    expect(top.barCorner).toBe('topRight');
    expect(top.bar.y).toBe(14);
    expect(inside(resizeLayout(grown({ x: 0, y: 0, ...PAGE }, 50), PAGE, CHIP, BAR).bar)).toBe(true);
    // No room above her: the chip goes 12 pt below.
    expect(resizeLayout(frame(1, 700, 0), PAGE, CHIP, BAR).chip.y).toBe(200 + 12);
    expect(middle.chip).toEqual({ x: 760 - CHIP.width / 2, y: 375 - 12 - 22, ...CHIP });
  });

  it('the percentage and the ruler', () => {
    expect([percentText(1.5), percentText(0.5), percentText(0.755)]).toEqual(['150 %', '50 %', '76 %']);
    expect([rulerPosition(0.2), rulerPosition(1), rulerPosition(2)]).toEqual([0, 1 / 3, 1]);
  });
});

const STATE: ResizeOverlayState = { frame: { x: 700, y: 375, width: 120, height: 200 }, scale: 1, limit: null, dragging: null };

function mount() {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  let push: (s: ResizeOverlayState) => void = () => {};
  vi.spyOn(bridge.resize, 'onState').mockImplementation((cb) => {
    push = cb;
    return () => {};
  });
  const calls = {
    act: vi.spyOn(bridge.resize, 'act'),
    drag: vi.spyOn(bridge.resize, 'drag'),
    endDrag: vi.spyOn(bridge.resize, 'endDrag'),
  };
  window.agenticComplex = bridge;
  render(<ResizeRoot />);
  return { calls, show: (s: ResizeOverlayState) => act(() => push(s)) };
}

describe('the resize overlay page', () => {
  it('shows nothing before the state, then a handle on each of her corners, the chip and the two buttons', () => {
    const { show } = mount();
    expect(screen.queryAllByRole('button')).toEqual([]);
    show(STATE);
    const handles = screen.getAllByRole('slider', { name: '调整大小手柄' });
    expect(handles.map((h) => [h.style.left, h.style.top])).toEqual([['688px', '363px'], ['808px', '363px'], ['688px', '563px'],
      ['808px', '563px']]);
    expect(handles[0]!.getAttribute('aria-valuetext')).toBe('100 %');
    expect(screen.getByRole('group', { name: '大小' }).textContent).toBe('100 %');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['恢复默认', '完成']);
    show({ ...STATE, frame: { x: 700, y: 375, width: 240, height: 400 }, scale: 2, limit: 'max' });
    expect(screen.getByRole('group', { name: '大小' }).textContent).toBe('200 %最大');
    expect(handles.every((h) => h.dataset.limit === 'max')).toBe(true);
  });

  it('a press on a handle starts its drag, the pointer sends its travel since the press, the release ends it', () => {
    const { calls, show } = mount();
    show(STATE);
    const topRight = screen.getAllByRole('slider')[1]!;
    fireEvent.mouseDown(topRight, { clientX: 820, clientY: 375, button: 0 });
    fireEvent.mouseMove(window, { clientX: 830, clientY: 360 });
    fireEvent.mouseMove(window, { clientX: 850, clientY: 340 });
    fireEvent.mouseUp(window, { clientX: 850, clientY: 340 });
    fireEvent.mouseMove(window, { clientX: 900, clientY: 300 });
    expect(calls.drag.mock.calls).toEqual([['topRight', 0, 0], ['topRight', 10, -15], ['topRight', 30, -35]]);
    expect(calls.endDrag).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(topRight, { clientX: 820, clientY: 375, button: 2 });
    expect(calls.drag).toHaveBeenCalledTimes(3);
  });

  it('恢复默认 and 完成 ask native for their action', () => {
    const { calls, show } = mount();
    show(STATE);
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(calls.act.mock.calls).toEqual([['restoreDefault'], ['done']]);
  });
});
