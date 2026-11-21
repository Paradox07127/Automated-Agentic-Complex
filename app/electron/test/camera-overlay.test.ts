// 调整镜头's camera mode and its window (src/main/camera/overlay.ts) over a fake BrowserWindow, a fake camera and fake presses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { cameraArea, CameraMode, type CameraValue } from '../src/common/camera-model.ts';
import { PageSession } from '../src/common/page.ts';
import type { ScreenInfo } from '../src/common/placement.ts';
import { CameraOverlayWindow } from '../src/main/camera/overlay.ts';
import { shellCamera } from '../src/main/camera/shell.ts';

const K = 0.4;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

function mode(value: CameraValue, closeupZoom: number | null = null) {
  const live: CameraValue[] = [], commits: CameraValue[] = [], cancels: CameraValue[] = [];
  let finished = 0;
  const m = new CameraMode(value, closeupZoom, { onChange: (v) => live.push(v), onCommit: (v) => commits.push(v),
    onCancel: (v) => cancels.push(v), onFinish: () => { finished += 1; } });
  return { m, live, commits, cancels, finished: () => finished };
}

test('AvatarCameraModelTests.testDragTurnsIntoYawAndPitch and testScrollAndPinchMultiplyTheZoom', () => {
  const a = mode({ yaw: 10, pitch: 0, zoom: 1 });
  a.m.drag(20, -10);
  near(a.m.value.yaw, 10 + 20 * K);
  near(a.m.value.pitch, -10 * K);
  assert.equal(a.m.dragging, true);
  assert.deepEqual(a.live, [a.m.value]);
  a.m.endDrag();
  assert.equal(a.m.dragging, false);
  const b = mode({ yaw: 0, pitch: 0, zoom: 2 });
  b.m.scroll(10);
  near(b.m.value.zoom, 2 * Math.exp(0.1));
  b.m.scroll(-10);
  near(b.m.value.zoom, 2);
  b.m.magnify(0.25);
  near(b.m.value.zoom, 2.5);
});

test('AvatarCameraModelTests.testValuesStayInTheirRanges, testButtonsSetTheZoomAndReset and testCloseupWaitsForTheHostsZoom', () => {
  const a = mode({ yaw: 500, pitch: -90, zoom: 9 });
  assert.deepEqual(a.m.value, { yaw: 180, pitch: -20, zoom: 4 });
  a.m.drag(1e6, 1e6);
  assert.deepEqual([a.m.value.yaw, a.m.value.pitch], [180, 20]);
  a.m.drag(-1e6, -1e6);
  assert.deepEqual([a.m.value.yaw, a.m.value.pitch], [-180, -20]);
  a.m.magnify(-0.99);
  a.m.scroll(-1e4);
  a.m.magnify(-5);
  assert.equal(a.m.value.zoom, 1);
  const b = mode({ yaw: 30, pitch: 5, zoom: 2.5 }, 3.2);
  b.m.fullBody();
  assert.deepEqual(b.m.value, { yaw: 30, pitch: 5, zoom: 1 });
  assert.equal(b.m.closeupEnabled, true);
  b.m.closeup();
  assert.deepEqual(b.m.value, { yaw: 30, pitch: 5, zoom: 3.2 });
  b.m.reset();
  assert.deepEqual(b.m.value, { yaw: 0, pitch: 0, zoom: 1 });
  const c = mode({ yaw: 0, pitch: 0, zoom: 1.5 });
  assert.equal(c.m.closeupEnabled, false);
  c.m.closeup();
  assert.equal(c.m.value.zoom, 1.5);
});

test('AvatarCameraModelTests.testCancelGoesBackToTheEntryValues, testCancelWithoutAMoveSendsNothing and testCommitRoundsToHalfDegrees', () => {
  const entry = { yaw: -37.5, pitch: 8, zoom: 2 };
  const a = mode(entry);
  a.m.drag(40, 10);
  a.m.scroll(30);
  a.m.cancel();
  assert.deepEqual([a.m.value, a.m.phase, a.cancels, a.finished()], [entry, 'cancelled', [entry], 1]);
  a.m.drag(10, 0);
  a.m.commit();
  assert.deepEqual([a.m.value, a.commits, a.finished()], [entry, [], 1]);
  const b = mode({ yaw: 0, pitch: 0, zoom: 1 });
  b.m.cancel();
  assert.deepEqual([b.cancels, b.m.phase], [[], 'cancelled']);
  const c = mode({ yaw: 0, pitch: 0, zoom: 1 });
  c.m.drag(-37.3 / K, 7.9 / K);
  c.m.magnify(1.2);
  c.m.commit();
  assert.equal(c.commits.length, 1);
  assert.deepEqual([c.commits[0]!.yaw, c.commits[0]!.pitch, c.m.phase, c.finished()], [-37.5, 8, 'committed', 1]);
  near(c.commits[0]!.zoom, 2.2);
  c.m.cancel();
  assert.equal(c.finished(), 1);
});

const SCREENS: ScreenInfo[] = [{ id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 0, w: 1440, h: 875 } },
  { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1050 } }];

test('AvatarCameraLayout.area: her visual box grown by 24 pt, in the top-left space of the visible frame', () => {
  assert.deepEqual(cameraArea({ x: 1600, y: 100, w: 200, h: 400 }, SCREENS[1]!.visibleFrame), { x: 136, y: 526, width: 248, height: 448 });
});

type Handler = (...args: never[]) => void;

/** A BrowserWindow in miniature: what the overlay calls, recorded; `contents` events fire through `emit`. */
function fakeWindow() {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const win = {
    webContents: { id: 41, isDestroyed: () => false, send: () => {}, on: (name: string, fn: Handler) => handlers.set(name, fn) },
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

function overlayWith() {
  const { win, calls, emit } = fakeWindow();
  const camera: string[] = [];
  let ops: ReadonlyMap<string, (args: unknown[], page: PageSession) => unknown> = new Map();
  let cursor = { x: 0, y: 0 };
  const listeners = new Set<(at: { x: number; y: number }) => void>();
  let made = 0;
  const overlay = new CameraOverlayWindow({
    url: 'agentic-complex-ui://app/stack.html#/camera',
    makeWindow: () => {
      made += 1;
      return win;
    },
    // Main screen 900 high, y down.
    toDip: (r) => ({ x: r.x, y: 900 - (r.y + r.h), width: r.w, height: r.h }),
    fromC3: (b) => b, screens: () => SCREENS, cursor: () => cursor,
    presses: (l) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    register: (_c, _p, m) => { ops = m; }, unregister: () => {}, baseOps: new Map(),
    camera: {
      live: (v) => camera.push(`live ${v.yaw},${v.pitch},${v.zoom}`),
      cancelled: () => camera.push('cancelled'),
      commit: (v) => camera.push(`commit ${v.yaw},${v.pitch},${v.zoom}`),
    },
  });
  const pushed: unknown[] = [];
  const page = new PageSession((_sub, _stream, _kind, payload) => { if (payload) pushed.push(JSON.parse(payload.data)); });
  const call = (op: string, ...args: unknown[]) => ops.get(op)!(args, page);
  const press = (at: { x: number; y: number }) => { for (const l of [...listeners]) l(at); };
  return { overlay, calls, emit, camera, call, pushed, press, listeners, made: () => made,
    setCursor: (p: { x: number; y: number }) => { cursor = p; } };
}

test('begin covers her screen\'s visible frame without taking the front app, pushes the area and value, and the page drags her', () => {
  const o = overlayWith();
  assert.equal(o.overlay.open, false);
  o.overlay.begin({ x: 1600, y: 100, w: 200, h: 400 }, { yaw: 10, pitch: 0, zoom: 1 }, 2);
  assert.equal(o.overlay.open, true);
  assert.deepEqual(o.calls, ['focusable false', 'load agentic-complex-ui://app/stack.html#/camera', 'bounds 1440,-150 1920x1050', 'showInactive']);
  o.call('camera.onState', 1);
  assert.deepEqual(o.pushed, [{ area: { x: 136, y: 526, width: 248, height: 448 }, value: { yaw: 10, pitch: 0, zoom: 1 }, editing: true,
    closeup: true }]);
  // Page drags are y down: 10 right and 5 down turn her right and tilt the camera down.
  o.call('camera.drag', 10, 5);
  o.call('camera.endDrag');
  o.call('camera.scroll', 0);
  o.call('camera.act', 'fullBody');
  assert.deepEqual(o.camera, [`live ${10 + 10 * K},${-5 * K},1`]);
  assert.throws(() => o.call('camera.act', 'zoom'), /invalid_args/);
  assert.throws(() => o.call('camera.drag', 'x', 1), /invalid_args/);
  o.call('camera.act', 'closeup');
  o.call('camera.act', 'commit');
  assert.deepEqual(o.camera.slice(1), [`live ${10 + 10 * K},${-5 * K},2`, 'commit 14,-2,2']);
  assert.equal(o.overlay.open, false);
  assert.equal(o.calls.at(-1), 'hide');
  assert.equal(o.listeners.size, 0);
  // The next 调整镜头 reuses the window.
  o.overlay.begin({ x: 100, y: 100, w: 200, h: 400 }, { yaw: 0, pitch: 0, zoom: 1 }, null);
  assert.equal(o.made(), 1);
  assert.deepEqual(o.pushed.at(-1), { area: { x: 76, y: 351, width: 248, height: 448 }, value: { yaw: 0, pitch: 0, zoom: 1 }, editing: true,
    closeup: false });
  o.overlay.stop();
  assert.equal(o.overlay.open, false);
});

test('Esc cancels and Return finishes once the overlay is key; a press outside the area and the bar cancels, one inside does not', () => {
  const o = overlayWith();
  o.overlay.begin({ x: 100, y: 100, w: 200, h: 400 }, { yaw: 0, pitch: 0, zoom: 1 }, null);
  o.call('window.setInteractiveRegions', [{ x: 76, y: 351, width: 248, height: 448 }]);
  // A press in a region keys the window, as a desktop panel's requestKey does.
  o.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 80, y: 400 });
  assert.deepEqual(o.calls.slice(-2), ['focusable true', 'focus']);
  o.press({ x: 150, y: 300 });
  assert.equal(o.overlay.open, true);
  o.call('camera.drag', 10, 0);
  let prevented = 0;
  o.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'a' });
  assert.equal(o.overlay.open, true);
  o.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'Escape' });
  assert.deepEqual([o.overlay.open, prevented, o.camera.at(-1)], [false, 1, 'cancelled']);
  o.overlay.begin({ x: 100, y: 100, w: 200, h: 400 }, { yaw: 0, pitch: 0, zoom: 1 }, null);
  o.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyDown', key: 'Enter' });
  assert.deepEqual([o.overlay.open, o.camera.at(-1)], [false, 'commit 0,0,1']);
  o.overlay.begin({ x: 100, y: 100, w: 200, h: 400 }, { yaw: 0, pitch: 0, zoom: 1 }, null);
  o.call('window.setInteractiveRegions', [{ x: 76, y: 351, width: 248, height: 448 }]);
  o.press({ x: 900, y: 300 });
  assert.equal(o.overlay.open, false);
});

test('the pointer poll takes clicks over the area and the bar only, and never lets go mid-drag', () => {
  const o = overlayWith();
  o.overlay.begin({ x: 100, y: 100, w: 200, h: 400 }, { yaw: 0, pitch: 0, zoom: 1 }, null);
  o.call('window.setInteractiveRegions', [{ x: 76, y: 351, width: 248, height: 448 }]);
  // The window's DIP bounds start at y 25 (900 − 875).
  o.setCursor({ x: 100, y: 400 });
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore false');
  o.call('camera.drag', 1, 0);
  o.setCursor({ x: 1000, y: 400 });
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore false');
  o.call('camera.endDrag');
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore true');
  o.call('camera.act', 'cancel');
  assert.equal(o.overlay.open, false);
});

test('shellCamera gives the overlay factory the camera, and 调整镜头 opens it on her figure', () => {
  let begun: unknown[] = [];
  const shell = shellCamera({
    link: { connected: true, capabilities: ['camera_free'], lastPipeline: null, sendCameraLive: () => true, sendSetRender: () => true,
      sendCloseup: () => true, sendSetPose: () => true, on: () => () => {} },
    configPath: '/nonexistent/config.json', avatarPid: () => null, save: () => {}, restartAvatar: () => {},
    figure: () => ({ x: 1, y: 2, w: 3, h: 4 }), log: () => {},
    overlay: (camera) => {
      assert.equal(typeof camera.commit, 'function');
      return { open: false, begin: (...args) => { begun = args; } };
    },
  });
  assert.equal(shell.camera.begin(), true);
  assert.deepEqual(begun, [{ x: 1, y: 2, w: 3, h: 4 }, { yaw: 0, pitch: 0, zoom: 1 }, null]);
});
