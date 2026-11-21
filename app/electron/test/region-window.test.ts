// 框选给她看…'s window (src/main/handover/region-window.ts), over fake BrowserWindows, a fake
// placement space and fake presses. Nothing here opens a window or reads the real pointer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { appKitY } from '../src/common/attention.ts';
import { PageSession } from '../src/common/page.ts';
import type { Point, Rect, ScreenInfo } from '../src/common/placement.ts';
import { selectRegion } from '../src/main/handover/region.ts';
import { RegionSelectWindow } from '../src/main/handover/region-window.ts';

const SCREENS: ScreenInfo[] = [{ id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 0, w: 1440, h: 875 } },
  { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1050 } }];
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

type Handler = (...args: never[]) => void;

/** A BrowserWindow in miniature: what the selector calls, recorded; `emit` fires its and its contents' events. */
function fakeWindow(id: number) {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let destroyed = false;
  const emit = (name: string, ...args: unknown[]) => (handlers.get(name) as ((...a: unknown[]) => void) | undefined)?.(...args);
  const win = {
    webContents: { id, isDestroyed: () => destroyed, send: () => {}, on: (name: string, fn: Handler) => handlers.set(name, fn) },
    on: (name: string, fn: Handler) => handlers.set(`win:${name}`, fn),
    isDestroyed: () => destroyed,
    loadURL: async (url: string) => { calls.push(`load ${url}`); },
    showInactive: () => calls.push('showInactive'),
    focus: () => calls.push('focus'),
    setFocusable: (on: boolean) => calls.push(`focusable ${on}`),
    setIgnoreMouseEvents: (on: boolean) => calls.push(`ignore ${on}`),
    getBounds: () => bounds,
    setBounds: (b: typeof bounds) => {
      bounds = b;
      calls.push(`bounds ${b.x},${b.y} ${b.width}x${b.height}`);
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      calls.push('destroy');
      emit('win:closed');
    },
  };
  return { win: win as unknown as BrowserWindow, calls, emit };
}

function selectorWith(screens: ScreenInfo[] = SCREENS) {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const ops = new Map<number, ReadonlyMap<string, (args: unknown[], page: PageSession) => unknown>>();
  const unregistered: number[] = [];
  let cursor: Point = { x: 0, y: 0 };
  const listeners = new Set<(at: Point) => void>();
  const selector = new RegionSelectWindow({
    url: 'agentic-complex-ui://app/stack.html#/region',
    makeWindow: () => {
      const w = fakeWindow(40 + windows.length);
      windows.push(w);
      return w.win;
    },
    // A Mac: the main screen 900 high, DIP y down, the placement space and C3 y up from its bottom.
    space: {
      screens: () => screens,
      fromDip: (r) => ({ x: r.x, y: 900 - (r.y + r.height), w: r.width, h: r.height }),
      rectToC3: (r) => r,
      pointFromC3: (p) => p,
    },
    toDip: (r: Rect) => ({ x: r.x, y: 900 - (r.y + r.h), width: r.w, height: r.h }),
    cursor: () => cursor,
    presses: (l) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    register: (contents, _page, m) => { ops.set(contents.id, m); },
    unregister: (id) => { unregistered.push(id); },
    baseOps: new Map([['window.logInfo', () => null]]),
  });
  const page = new PageSession(() => {});
  const call = (op: string, ...args: unknown[]) => ops.get(40 + windows.length - 1)!.get(op)!(args, page);
  const press = (at: Point) => { for (const l of [...listeners]) l(at); };
  return { selector, windows, ops, unregistered, call, press, listeners, last: () => windows.at(-1)!,
    setCursor: (p: Point) => { cursor = p; } };
}

test('select covers the whole screen under the pointer without taking the front app; the page\'s drag is the rect in C3 points', async () => {
  const s = selectorWith();
  s.setCursor({ x: 1500, y: 100 });
  const chosen = s.selector.select();
  const w = s.last();
  assert.deepEqual(w.calls, ['focusable false', 'ignore false', 'load agentic-complex-ui://app/stack.html#/region',
    'bounds 1440,-180 1920x1080', 'showInactive']);
  assert.deepEqual([...s.ops.get(40)!.keys()], ['window.logInfo', 'region.finish', 'region.cancel']);
  // Page points, y down from the window's top left; either corner first.
  s.call('region.finish', { x: 110, y: 70 }, { x: 10, y: 20 });
  assert.deepEqual(await chosen, { x: 1450, y: 1010, w: 100, h: 50 });
  assert.equal(w.calls.at(-1), 'destroy');
  assert.deepEqual([s.unregistered, s.listeners.size], [[40], 0]);
  // selectRegion reads it in CG points: the page's top left on screen.
  const reads: unknown[] = [];
  s.setCursor({ x: 100, y: 100 });
  const done = selectRegion({ select: () => s.selector.select(), read: async (rect) => { reads.push(rect); return { kind: 'refused', text: 'x' }; },
    excluded: () => [], helperY: appKitY, mainHeight: () => 900, desktop: () => null, log: () => {} });
  assert.equal(s.last().calls[3], 'bounds 0,0 1440x900');
  s.call('region.finish', { x: 100, y: 200 }, { x: 400, y: 300 });
  await done;
  assert.deepEqual(reads, [{ x: 100, y: 200, width: 300, height: 100 }]);
});

test('a side under 8 pt, Esc once keyed, the page\'s cancel and a press off the screen each cancel; a press on it does not', async () => {
  const s = selectorWith();
  let chosen = s.selector.select();
  s.call('region.finish', { x: 0, y: 0 }, { x: 7, y: 100 });
  assert.equal(await chosen, null);
  assert.equal(s.last().calls.at(-1), 'destroy');

  chosen = s.selector.select();
  let prevented = 0;
  // A press keys the window (RegionSelectPanel takes key at once; this one waits for the press) so Esc reaches it.
  s.last().emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 5, y: 5 });
  assert.deepEqual(s.last().calls.slice(-2), ['focusable true', 'focus']);
  s.last().emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'a' });
  s.last().emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'Escape' });
  assert.deepEqual([await chosen, prevented], [null, 1]);

  chosen = s.selector.select();
  s.call('region.cancel');
  assert.equal(await chosen, null);

  chosen = s.selector.select();
  s.press({ x: 700, y: 400 });
  await settle();
  assert.equal(s.last().calls.includes('destroy'), false);
  s.press({ x: 2000, y: 400 });
  assert.equal(await chosen, null);
  assert.equal(s.listeners.size, 0);
});

test('a second select cancels the first; a closed window or a gone page cancels; ops after the end or with bad args fail', async () => {
  const s = selectorWith();
  const first = s.selector.select();
  const second = s.selector.select();
  assert.equal(await first, null);
  assert.deepEqual([s.windows.length, s.windows[0]!.calls.at(-1)], [2, 'destroy']);
  assert.throws(() => s.call('region.finish', { x: 0 }, { x: 1, y: 1 }), /invalid_args/);
  s.last().emit('render-process-gone');
  assert.equal(await second, null);
  assert.throws(() => s.call('region.cancel'), /failed/);

  // A page that does not load would leave the transparent window over the screen taking every click.
  const failed = s.selector.select();
  s.last().emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'agentic-complex-ui://app/stack.html#/region', false);
  await settle();
  assert.equal(s.last().calls.includes('destroy'), false);
  s.last().emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'agentic-complex-ui://app/stack.html#/region', true);
  assert.equal(await failed, null);
  assert.equal(s.last().calls.at(-1), 'destroy');

  const third = s.selector.select();
  s.last().win.destroy();
  assert.equal(await third, null);

  const fourth = s.selector.select();
  s.selector.stop();
  assert.equal(await fourth, null);

  // The pointer off every screen takes the main one; no screen at all shows nothing.
  s.setCursor({ x: -5000, y: 0 });
  void s.selector.select();
  assert.equal(s.last().calls[3], 'bounds 0,0 1440x900');
  s.selector.stop();
  const none = selectorWith([]);
  assert.equal(await none.selector.select(), null);
  assert.equal(none.windows.length, 0);
});
