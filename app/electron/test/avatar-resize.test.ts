// 调整大小's resize mode (src/common/avatar-resize.ts), where it starts, and its window
// (src/main/placement/resize-overlay.ts) over a fake BrowserWindow, a fake placement and fake presses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { type AvatarCorner, cornerPoint, ResizeMode, resizeStart } from '../src/common/avatar-resize.ts';
import { PageSession } from '../src/common/page.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';
import { ResizeOverlayWindow } from '../src/main/placement/resize-overlay.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const nearPoint = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  near(a.x, b.x);
  near(a.y, b.y);
};
/** AvatarLayerTests: her size at 100 % and her frame at `scale`, y up. */
const base = { w: 120, h: 200 };
const frame = (scale: number, x = 700, y = 300): Rect => ({ x, y, w: base.w * scale, h: base.h * scale });

function mode(f: Rect, scale: number, maximumScale = 2) {
  const changes: number[] = [], commits: number[] = [];
  let finished = 0;
  const m = new ResizeMode(f, scale, maximumScale, { onScaleChange: (s) => changes.push(s), onCommit: (s) => commits.push(s),
    onFinish: () => { finished += 1; } });
  return { m, changes, commits, finished: () => finished };
}

test('AvatarLayerTests.testDragBottomRightGrowsClampsAndKeepsOppositeCorner', () => {
  const { m, changes } = mode(frame(1), 1);
  const anchor = { x: 700, y: 500 };
  m.drag('bottomRight', 60, -100);
  near(m.scale, 1.5);
  m.drag('bottomRight', 2000, -2000);
  assert.equal(m.scale, 2);
  assert.equal(m.limit, 'max');
  near(m.frame.w, 240);
  nearPoint(cornerPoint('topLeft', m.frame), anchor);
  m.drag('bottomRight', -2000, 2000);
  assert.equal(m.scale, 0.5);
  assert.equal(m.limit, 'min');
  nearPoint(cornerPoint('topLeft', m.frame), anchor);
  m.endDrag();
  assert.equal(m.dragging, null);
  assert.equal(changes.length, 3);
  near(changes[0]!, 1.5);
  assert.deepEqual(changes.slice(1), [2, 0.5]);
});

test('AvatarLayerTests.testDragTopLeftKeepsBottomRight', () => {
  const { m } = mode(frame(1), 1);
  const anchor = { x: 820, y: 300 };
  m.drag('topLeft', -12, 20);
  near(m.scale, 1.1);
  nearPoint(cornerPoint('bottomRight', m.frame), anchor);
  m.drag('topLeft', 500, -900);
  assert.equal(m.scale, 0.5);
  nearPoint(cornerPoint('bottomRight', m.frame), anchor);
});

test('AvatarLayerTests.testDoneCancelRestore', () => {
  const done = mode(frame(1), 1);
  done.m.drag('bottomRight', 60, -100);
  done.m.endDrag();
  done.m.done();
  done.m.done();
  done.m.drag('bottomRight', 60, -100);
  assert.equal(done.commits.length, 1);
  near(done.commits[0]!, 1.5);
  assert.deepEqual([done.m.phase, done.finished()], ['committed', 1]);

  const start = frame(0.8);
  const cancel = mode(start, 0.8);
  cancel.m.drag('topRight', 500, 500);
  assert.equal(cancel.m.scale, 2);
  cancel.m.cancel();
  assert.deepEqual([cancel.m.scale, cancel.m.frame, cancel.m.phase], [0.8, start, 'cancelled']);
  assert.deepEqual([cancel.changes, cancel.commits, cancel.finished()], [[2, 0.8], [], 1]);
  const still = mode(start, 0.8);
  still.m.cancel();
  assert.deepEqual([still.changes, still.finished()], [[], 1], 'a cancel without a change sends nothing');

  const restore = mode(frame(2), 2);
  const foot = { x: restore.m.frame.x + restore.m.frame.w / 2, y: restore.m.frame.y };
  restore.m.restoreDefault();
  assert.deepEqual([restore.m.scale, restore.m.phase], [1, 'editing']);
  nearPoint({ x: restore.m.frame.x + restore.m.frame.w / 2, y: restore.m.frame.y }, foot);
  assert.deepEqual([restore.m.frame.w, restore.m.frame.h], [base.w, base.h]);
});

test('RenderControlsTests.testWindowResizePreviewUsesTheSameVisibleScreenLimitAsTheAvatar', () => {
  const { m, changes } = mode({ x: 100, y: 0, w: 270, h: 390 }, 0.5, 1050 / 780);
  m.drag('topRight', 2000, 2000);
  near(m.scale, 1050 / 780);
  near(m.frame.h, 1050);
  assert.equal(changes.at(-1), m.scale);
  assert.equal(m.limit, 'max');
  m.cancel();
  assert.equal(changes.at(-1), 0.5);
  assert.deepEqual(m.frame, m.initialFrame);
});

test('the entry scale and the largest are clamped into 0.5–2 and 0.5–2', () => {
  assert.deepEqual([new ResizeMode(frame(1), 9, Infinity, { onScaleChange() {}, onCommit() {}, onFinish() {} }).scale,
    new ResizeMode(frame(1), 0.1, 0.2, { onScaleChange() {}, onCommit() {}, onFinish() {} }).maximumScale], [2, 0.5]);
});

const MAIN: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 0, w: 1440, h: 875 } };
const SIDE: ScreenInfo = { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1050 } };

test('beginResize: fullscreen is 540×780 at her scale on her anchor, a window its frame; the window viewport caps the scale to her screen', () => {
  const placement = { x: 2000, y: 100, scale: 1.25 };
  assert.deepEqual(resizeStart(true, placement, { x: 1440, y: 0, w: 1920, h: 1080 }, [MAIN, SIDE]),
    { frame: { x: 2000 - 337.5, y: 100, w: 675, h: 975 }, scale: 1.25, maximumScale: 2, visible: SIDE.visibleFrame });
  assert.deepEqual(resizeStart(true, null, { x: 0, y: 0, w: 1440, h: 900 }, [MAIN, SIDE]),
    { frame: { x: 0, y: 0, w: 1440, h: 900 }, scale: 1, maximumScale: 2, visible: MAIN.visibleFrame }, 'no placement yet');
  assert.deepEqual(resizeStart(false, { ...placement, scale: 0.5 }, { x: 100, y: 0, w: 270, h: 390 }, [MAIN, SIDE]),
    { frame: { x: 100, y: 0, w: 270, h: 390 }, scale: 0.5, maximumScale: 875 / 780, visible: MAIN.visibleFrame });
  assert.deepEqual(resizeStart(false, null, { x: 5000, y: 5000, w: 270, h: 390 }, [MAIN, SIDE])?.visible, MAIN.visibleFrame,
    'off every screen: the first');
  assert.equal(resizeStart(false, null, null, [MAIN]), null);
  assert.equal(resizeStart(false, null, frame(1), []), null);
});

type Handler = (...args: never[]) => void;

/** A BrowserWindow in miniature: what the overlay calls, recorded; `contents` events fire through `emit`. */
function fakeWindow() {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const win = {
    webContents: { id: 42, isDestroyed: () => false, send: () => {}, on: (name: string, fn: Handler) => handlers.set(name, fn) },
    on: (name: string, fn: Handler) => handlers.set(`win:${name}`, fn),
    isDestroyed: () => false,
    loadURL: async (url: string) => { calls.push(`load ${url}`); },
    showInactive: () => calls.push('showInactive'),
    hide: () => calls.push('hide'),
    focus: () => calls.push('focus'),
    setFocusable: (on: boolean) => calls.push(`focusable ${on}`),
    setIgnoreMouseEvents: (on: boolean) => calls.push(`ignore ${on}`),
    getBounds: () => bounds,
    setBounds: (b: typeof bounds) => {
      bounds = b;
      calls.push(`bounds ${b.x},${b.y} ${b.width}x${b.height}`);
    },
    destroy: () => calls.push('destroy'),
  };
  const emit = (name: string, ...args: unknown[]) => (handlers.get(name) as ((...a: unknown[]) => void) | undefined)?.(...args);
  return { win: win as unknown as BrowserWindow, calls, emit };
}

const rect = (r: Rect) => `${r.x},${r.y} ${r.w}x${r.h}`;

function overlayWith(start: ReturnType<typeof resizeStart> = { frame: frame(1), scale: 1, maximumScale: 2, visible: MAIN.visibleFrame }) {
  const { win, calls, emit } = fakeWindow();
  const placed: string[] = [];
  let ops: ReadonlyMap<string, (args: unknown[], page: PageSession) => unknown> = new Map();
  let cursor = { x: 0, y: 0 };
  const listeners = new Set<(at: { x: number; y: number }) => void>();
  let made = 0;
  const overlay = new ResizeOverlayWindow({
    url: 'agentic-complex-ui://app/stack.html#/resize',
    makeWindow: () => {
      made += 1;
      return win;
    },
    // Main screen 900 high, y down.
    toDip: (r) => ({ x: r.x, y: 900 - (r.y + r.h), width: r.w, height: r.h }),
    fromC3: (b) => b, cursor: () => cursor,
    presses: (l) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    register: (_c, _p, m) => { ops = m; }, unregister: () => {}, baseOps: new Map(),
    target: {
      resizeStart: () => start,
      resizePreview: (s, f) => placed.push(`preview ${s} ${rect(f)}`),
      resizeCommit: (s, f) => placed.push(`commit ${s} ${rect(f)}`),
    },
  });
  const pushed: unknown[] = [];
  const page = new PageSession((_sub, _stream, _kind, payload) => { if (payload) pushed.push(JSON.parse(payload.data)); });
  const call = (op: string, ...args: unknown[]) => ops.get(op)!(args, page);
  const press = (at: { x: number; y: number }) => { for (const l of [...listeners]) l(at); };
  return { overlay, calls, emit, placed, call, pushed, press, listeners, made: () => made,
    setCursor: (p: { x: number; y: number }) => { cursor = p; } };
}

test('begin covers her screen\'s visible frame without taking the front app; the page drags a corner and 完成 commits', () => {
  const o = overlayWith();
  assert.equal(o.overlay.open, false);
  assert.equal(o.overlay.begin(), true);
  assert.equal(o.overlay.open, true);
  assert.deepEqual(o.calls, ['focusable false', 'load agentic-complex-ui://app/stack.html#/resize', 'bounds 0,25 1440x875', 'showInactive']);
  o.call('resize.onState', 1);
  // Her frame in the page: top-left of the visible frame, y down.
  assert.deepEqual(o.pushed, [{ frame: { x: 700, y: 375, width: 120, height: 200 }, scale: 1, limit: null, dragging: null }]);
  // Page drags are y down: 60 right and 100 down from the bottom-right grow her to 150 %, the top-left fixed.
  o.call('resize.drag', 'bottomRight', 60, 100);
  assert.deepEqual(o.placed, ['preview 1.5 700,200 180x300']);
  assert.deepEqual(o.pushed.at(-1), { frame: { x: 700, y: 375, width: 180, height: 300 }, scale: 1.5, limit: null, dragging: 'bottomRight' });
  // 调整大小 again while it is open keeps the edit.
  assert.equal(o.overlay.begin(), true);
  o.call('resize.endDrag');
  assert.deepEqual(o.pushed.at(-1), { frame: { x: 700, y: 375, width: 180, height: 300 }, scale: 1.5, limit: null, dragging: null });
  o.call('resize.drag', 'topLeft', -1000, -1000);
  assert.deepEqual(o.pushed.at(-1), { frame: { x: 640, y: 275, width: 240, height: 400 }, scale: 2, limit: 'max', dragging: 'topLeft' });
  o.call('resize.act', 'restoreDefault');
  assert.deepEqual(o.placed.at(-1), 'preview 1 700,200 120x200');
  assert.throws(() => o.call('resize.act', 'zoom'), /invalid_args/);
  assert.throws(() => o.call('resize.drag', 'middle', 1, 1), /invalid_args/);
  assert.throws(() => o.call('resize.drag', 'topLeft', 'x', 1), /invalid_args/);
  o.call('resize.act', 'done');
  assert.deepEqual(o.placed.at(-1), 'commit 1 700,200 120x200');
  assert.equal(o.overlay.open, false);
  assert.equal(o.calls.at(-1), 'hide');
  assert.equal(o.listeners.size, 0);
  assert.throws(() => o.call('resize.endDrag'), /failed/);
  // The next 调整大小 reuses the window.
  assert.equal(o.overlay.begin(), true);
  assert.equal(o.made(), 1);
  o.overlay.stop();
  assert.equal(o.overlay.open, false);
});

test('without her frame 调整大小 opens nothing, as beginResize returns', () => {
  const o = overlayWith(null);
  assert.equal(o.overlay.begin(), false);
  assert.deepEqual([o.overlay.open, o.made(), o.calls], [false, 0, []]);
});

test('AvatarLayerTests.testControllerKeysAndOutsideClick: Esc cancels back to the entry, Return finishes, a press outside cancels', () => {
  const o = overlayWith();
  o.overlay.begin();
  const bar = { x: 1200, y: 800, width: 200, height: 40 };
  o.call('window.setInteractiveRegions', [bar]);
  // A press in a region keys the window, as a desktop panel's requestKey does.
  o.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 1210, y: 810 });
  assert.deepEqual(o.calls.slice(-2), ['focusable true', 'focus']);
  // C3 y up: page y 820 is 875 − 820 = 55.
  o.press({ x: 1300, y: 55 });
  assert.equal(o.overlay.open, true);
  o.call('resize.drag', 'bottomLeft', -60, 100);
  let prevented = 0;
  o.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'a' });
  assert.equal(o.overlay.open, true);
  o.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'Escape' });
  assert.deepEqual([o.overlay.open, prevented, o.placed.at(-1)], [false, 1, 'preview 1 700,300 120x200']);
  assert.equal(o.placed.filter((l) => l.startsWith('commit')).length, 0);

  o.overlay.begin();
  o.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyDown', key: 'Enter' });
  assert.deepEqual([o.overlay.open, o.placed.at(-1)], [false, 'commit 1 700,300 120x200']);

  o.overlay.begin();
  o.call('window.setInteractiveRegions', [bar]);
  o.press({ x: 100, y: 600 });
  assert.equal(o.overlay.open, false);
  assert.equal(o.placed.at(-1), 'commit 1 700,300 120x200', 'a cancel without a change previews nothing');
});

test('the pointer poll takes clicks over the handles and the bar only, and never lets go mid-drag', () => {
  const o = overlayWith();
  o.overlay.begin();
  const corners: AvatarCorner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  o.call('window.setInteractiveRegions', corners.map((_c, i) => ({ x: 688 + i * 10, y: 363, width: 24, height: 24 })));
  // The window's DIP bounds start at y 25 (900 − 875).
  o.setCursor({ x: 700, y: 400 });
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore false');
  o.call('resize.drag', 'topLeft', 0, 0);
  o.setCursor({ x: 100, y: 400 });
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore false');
  o.call('resize.endDrag');
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore true');
  o.call('resize.act', 'cancel');
  assert.equal(o.overlay.open, false);
});

for (const event of ['render-process-gone', 'unresponsive']) {
  test(`a page that is ${event === 'unresponsive' ? 'hung' : 'gone'} mid-drag cancels the edit and lets clicks through again`, () => {
    const o = overlayWith();
    try {
      o.overlay.begin();
      o.call('window.setInteractiveRegions', [{ x: 688, y: 363, width: 24, height: 24 }]);
      o.setCursor({ x: 700, y: 400 });
      o.overlay.tick();
      o.call('resize.drag', 'bottomRight', 60, 100);
      o.emit(event);
      o.setCursor({ x: 100, y: 400 });
      o.overlay.tick();
      assert.equal(o.calls.filter((c) => c.startsWith('ignore')).at(-1), 'ignore true', 'the window takes the pointer');
      assert.equal(o.overlay.open, false);
      assert.deepEqual(o.calls.slice(-3), ['focusable false', 'ignore true', 'hide']);
      assert.equal(o.placed.at(-1), 'preview 1 700,300 120x200');
    } finally {
      o.overlay.stop();
    }
  });
}
