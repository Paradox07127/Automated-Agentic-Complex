// 拍照's window (src/main/camera/photo-overlay.ts): the photo state it holds on her renderer while open, the page's
// `photo.*` ops, and what closes it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { BridgeFailure } from '../src/common/bridge.ts';
import type { AvatarHello, Box } from '../src/common/c3.ts';
import { PageSession } from '../src/common/page.ts';
import type { ScreenInfo } from '../src/common/placement.ts';
import { PhotoOverlayWindow, type PhotoTarget } from '../src/main/camera/photo-overlay.ts';
import { CAPTURE_OFFERS, linkAvatarHost } from '../src/main/renderer/avatar-host.ts';
import { ActionFailure, HostLink, type LinkEvent } from '../src/main/renderer/link.ts';
import { FakeAvatar } from './fake-avatar.ts';

const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.01);
  }
  return ok();
}

type Handler = (...args: never[]) => void;

/** A BrowserWindow in miniature: what the overlay calls, recorded; `contents` events fire through `emit`. */
function fakeWindow() {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const win = {
    webContents: { id: 43, isDestroyed: () => false, send: () => {}, on: (name: string, fn: Handler) => handlers.set(name, fn) },
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

const MAIN: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 0, w: 1440, h: 875 } };
const SIDE: ScreenInfo = { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1050 } };

/** A renderer as the overlay sees it; the test sets what it lists and what the shutter answers. */
class Target implements PhotoTarget {
  hello: AvatarHello | null = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['ack', 'render_live', 'photo', 'capture'] };
  companionCapabilities = ['render_live', 'photo', 'capture'];
  photos: [boolean, number, number | null][] = [];
  listeners = new Set<(e: LinkEvent) => void>();
  shot: () => Promise<{ file: string; width: number; height: number }> = async () => ({ file: 'Endfield-si-20261120-101010.png', width: 1080, height: 1920 });
  backgrounds: string[] = [];
  capture?: (background: string) => Promise<{ file: string; width: number; height: number }> = (background) => {
    this.backgrounds.push(background);
    return this.shot();
  };
  sendPhoto(active: boolean, aperture: number, focus: number | null): boolean {
    this.photos.push([active, aperture, focus]);
    return true;
  }
  on(l: (e: LinkEvent) => void) {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

function overlayWith(figure: Box | null = { x: 700, y: 300, w: 180, h: 280 }, link: PhotoTarget = new Target()) {
  const { win, calls, emit } = fakeWindow();
  let ops: ReadonlyMap<string, (args: unknown[], page: PageSession) => unknown> = new Map();
  let cursor = { x: 0, y: 0 };
  const listeners = new Set<(at: { x: number; y: number }) => void>();
  let made = 0;
  const overlay = new PhotoOverlayWindow({
    url: 'agentic-complex-ui://app/stack.html#/photo',
    makeWindow: () => {
      made += 1;
      return win;
    },
    // Main screen 900 high, y down.
    toDip: (r) => ({ x: r.x, y: 900 - (r.y + r.h), width: r.w, height: r.h }),
    fromC3: (b) => b, screens: () => [MAIN, SIDE], cursor: () => cursor,
    presses: (l) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    register: (_c, _p, m) => { ops = m; }, unregister: () => {}, baseOps: new Map([['window.close', () => null]]),
    figure: () => figure, link,
  });
  const pushed: unknown[] = [];
  const page = new PageSession((_sub, _stream, _kind, payload) => { if (payload) pushed.push(JSON.parse(payload.data)); });
  const call = (op: string, ...args: unknown[]) => ops.get(op)!(args, page);
  const press = (at: { x: number; y: number }) => { for (const l of [...listeners]) l(at); };
  return { overlay, calls, emit, call, ops: () => ops, pushed, press, listeners, made: () => made,
    setCursor: (p: { x: number; y: number }) => { cursor = p; } };
}

async function failure(p: unknown): Promise<{ code: string; detail: string }> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BridgeFailure);
    return { code: e.code, detail: e.detail };
  }
  assert.fail('did not throw');
}

test('begin covers her screen\'s visible frame without taking the front app, opens the photo state at f/32 auto and pushes her figure', () => {
  const link = new Target();
  const o = overlayWith(undefined, link);
  assert.equal(o.overlay.open, false);
  assert.equal(o.overlay.begin(), true);
  assert.equal(o.overlay.open, true);
  assert.deepEqual(o.calls, ['focusable false', 'load agentic-complex-ui://app/stack.html#/photo', 'bounds 0,25 1440x875', 'showInactive']);
  assert.deepEqual(link.photos, [[true, 32, null]]);
  o.call('photo.onState', 1);
  // Her figure in the page: top-left of the visible frame, y down.
  assert.deepEqual(o.pushed, [{ anchor: { x: 700, y: 295, width: 180, height: 280 }, photo: true, capture: true }]);
  // 拍照 again while it is open changes nothing.
  assert.equal(o.overlay.begin(), true);
  assert.deepEqual(link.photos, [[true, 32, null]]);
  // Only this page has the photo ops, next to the stack surface's own.
  assert.deepEqual([...o.ops().keys()].sort(), ['photo.capture', 'photo.close', 'photo.onState', 'photo.set', 'window.close',
    'window.setInteractiveRegions']);
  assert.equal(o.call('photo.close'), null);
  assert.equal(o.overlay.open, false);
  assert.deepEqual(link.photos, [[true, 32, null], [false, 32, null]]);
  assert.equal(o.calls.at(-1), 'destroy');
  assert.equal(o.listeners.size, 0);
  assert.equal(link.listeners.size, 0);
  // The next 拍照 creates a fresh window since close() destroyed the transient overlay.
  assert.equal(o.overlay.begin(), true);
  assert.equal(o.made(), 2);
  o.overlay.stop();
  assert.equal(o.overlay.open, false);
  assert.deepEqual(link.photos.at(-1), [false, 32, null]);
  assert.equal(o.calls.at(-1), 'destroy');
});

test('on her other screen it covers that screen\'s visible frame', () => {
  const o = overlayWith({ x: 2000, y: 100, w: 200, h: 300 });
  o.overlay.begin();
  assert.equal(o.calls[2], 'bounds 1440,-150 1920x1050');
  o.call('photo.onState', 1);
  assert.deepEqual(o.pushed, [{ anchor: { x: 560, y: 650, width: 200, height: 300 }, photo: true, capture: true }]);
  o.overlay.stop();
});

test('without her figure 拍照 opens nothing; a renderer without `photo` never gets the photo state', () => {
  const none = overlayWith(null);
  assert.equal(none.overlay.begin(), false);
  assert.deepEqual([none.overlay.open, none.made(), none.calls], [false, 0, []]);
  const link = new Target();
  link.hello = { ...link.hello!, capabilities: ['ack', 'render_live', 'capture'] };
  const bare = overlayWith(undefined, link);
  assert.equal(bare.overlay.begin(), true);
  bare.call('photo.onState', 1);
  assert.deepEqual(bare.pushed, [{ anchor: { x: 700, y: 295, width: 180, height: 280 }, photo: false, capture: true }]);
  bare.call('photo.close');
  assert.deepEqual(link.photos, []);
  // Each counts only when this app lists it too.
  const unoffered = new Target();
  unoffered.companionCapabilities = ['render_live', 'photo'];
  const shy = overlayWith(undefined, unoffered);
  shy.overlay.begin();
  shy.call('photo.onState', 1);
  assert.deepEqual(shy.pushed, [{ anchor: { x: 700, y: 295, width: 180, height: 280 }, photo: true, capture: false }]);
  shy.overlay.stop();
});

test('photo.set takes set_render.photo\'s ranges and sends it active; out of range or once closed it fails', async () => {
  const link = new Target();
  const o = overlayWith(undefined, link);
  o.overlay.begin();
  assert.equal(o.call('photo.set', { aperture: 2.8, focus: 'auto' }), null);
  assert.equal(o.call('photo.set', { aperture: 1.4, focus: 0.1 }), null);
  assert.equal(o.call('photo.set', { aperture: 32, focus: 10 }), null);
  assert.deepEqual(link.photos.slice(1), [[true, 2.8, null], [true, 1.4, 0.1], [true, 32, 10]]);
  const invalid = { code: 'invalid_args', detail: '{aperture 1.4–32, focus auto or 0.1–10}' };
  for (const bad of [undefined, null, [], { aperture: 1.3, focus: 'auto' }, { aperture: 33, focus: 'auto' }, { aperture: '2.8', focus: 'auto' },
    { aperture: 2.8 }, { aperture: 2.8, focus: 0.05 }, { aperture: 2.8, focus: 11 }, { aperture: 2.8, focus: 'near' }, { aperture: 2.8, focus: null }]) {
    assert.deepEqual(await failure((async () => o.call('photo.set', bad))()), invalid, JSON.stringify(bad));
  }
  assert.equal(link.photos.length, 4);
  o.call('photo.close');
  assert.deepEqual(await failure((async () => o.call('photo.set', { aperture: 4, focus: 'auto' }))()), { code: 'failed', detail: '拍照已结束' });
  assert.equal(link.photos.length, 5);
});

test('photo.capture: a transparent capture answers the file name of her `captured`; every failure `failed`', async () => {
  const link = new Target();
  const o = overlayWith(undefined, link);
  o.overlay.begin();
  assert.deepEqual(await o.call('photo.capture'), { file: 'Endfield-si-20261120-101010.png' });
  assert.deepEqual(link.backgrounds, ['transparent']);
  for (const [code, message] of [['unsupported', 'unsupported'], ['busy', 'busy'], ['failed', 'disk_full'], ['timeout', 'timeout']] as const) {
    link.shot = async () => { throw new ActionFailure(code, message); };
    assert.deepEqual(await failure(o.call('photo.capture')), { code: 'failed', detail: message }, code);
  }
  // No capture directory given: the link has no `capture`.
  link.capture = undefined;
  assert.deepEqual(await failure(o.call('photo.capture')), { code: 'not_implemented', detail: 'photo.capture' });
  o.call('photo.close');
  assert.deepEqual(await failure(o.call('photo.capture')), { code: 'failed', detail: '拍照已结束' });
});

test('Esc, a press outside the bar, a page that is gone or hung and a lost renderer close it and end the photo state', () => {
  const link = new Target();
  const o = overlayWith(undefined, link);
  const bar = { x: 600, y: 600, width: 400, height: 120 };
  const ends = () => link.photos.filter(([active]) => !active).length;

  o.overlay.begin();
  o.call('window.setInteractiveRegions', [bar]);
  // A press in a region keys the window, as a desktop panel's requestKey does.
  o.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 610, y: 610 });
  assert.deepEqual(o.calls.slice(-2), ['focusable true', 'focus']);
  // C3 y up: page y 650 is 875 − 650 = 225.
  o.press({ x: 700, y: 225 });
  assert.equal(o.overlay.open, true);
  let prevented = 0;
  o.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'Enter' });
  assert.equal(o.overlay.open, true);
  o.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { type: 'keyDown', key: 'Escape' });
  assert.deepEqual([o.overlay.open, prevented, ends()], [false, 1, 1]);
  assert.deepEqual(o.calls.slice(-2), ['focusable false', 'destroy']);

  o.overlay.begin();
  o.call('window.setInteractiveRegions', [bar]);
  o.press({ x: 100, y: 600 });
  assert.deepEqual([o.overlay.open, ends()], [false, 2]);

  for (const event of ['render-process-gone', 'unresponsive']) {
    o.overlay.begin();
    o.emit(event);
    assert.deepEqual([o.overlay.open, ends()], [false, event === 'unresponsive' ? 4 : 3], event);
  }

  o.overlay.begin();
  for (const l of [...link.listeners]) l({ kind: 'lost', reason: 'eof' });
  assert.deepEqual([o.overlay.open, ends(), link.listeners.size], [false, 5, 0]);
  // Closing twice ends the photo state once.
  o.call('photo.close');
  assert.equal(ends(), 5);
});

test('the pointer poll takes clicks over the bar only', () => {
  const o = overlayWith();
  o.overlay.begin();
  o.call('window.setInteractiveRegions', [{ x: 600, y: 600, width: 400, height: 120 }]);
  // The window's DIP bounds start at y 25 (900 − 875).
  o.setCursor({ x: 700, y: 650 });
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore false');
  o.setCursor({ x: 100, y: 400 });
  o.overlay.tick();
  assert.equal(o.calls.at(-1), 'ignore true');
  assert.throws(() => o.call('window.setInteractiveRegions', [{ x: 'a' }]), /invalid_args/);
  o.overlay.stop();
});

test('over C3: photo.set sends set_render.photo, photo.capture sends `capture` and answers her `captured`', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'photo-l-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {}, cursor: () => ({ x: 1150, y: 1200 }), offers: CAPTURE_OFFERS });
  await link.start();
  const saved: string[] = [];
  const captureDir = join(dir, 'Pictures', 'Agentic Complex');
  const o = overlayWith(undefined, linkAvatarHost(link, () => true, { captureDir, captureSaved: (file) => saved.push(file) }));
  try {
    const a = new FakeAvatar(link.path);
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: ['ack', 'render_live', 'photo', 'capture'] });
    assert.ok(await until(2, () => link.hello?.pid === 99));

    assert.equal(o.overlay.begin(), true);
    assert.ok(await until(1, () => a.last('set_render') !== undefined));
    assert.deepEqual(a.last('set_render')!.photo, { active: true, aperture: 32, focus: 'auto' });
    assert.equal(o.call('photo.set', { aperture: 2.8, focus: 1.5 }), null);
    assert.ok(await until(1, () => (a.last('set_render')!.photo as { aperture: number }).aperture === 2.8));
    assert.deepEqual(a.last('set_render')!.photo, { active: true, aperture: 2.8, focus: 1.5 });
    assert.equal(typeof a.last('set_render')!.req, 'number');

    const shot = o.call('photo.capture') as Promise<unknown>;
    assert.ok(await until(1, () => a.last('capture') !== undefined));
    const req = a.last('capture')!.req;
    assert.equal(a.last('capture')!.background, 'transparent');
    assert.ok(existsSync(captureDir));
    a.send({ type: 'ack', req, ok: true });
    a.send({ type: 'captured', req, file: 'Endfield-aster-20261120-101010.png', width: 1080, height: 1920 });
    assert.deepEqual(await shot, { file: 'Endfield-aster-20261120-101010.png' });
    assert.deepEqual(saved, ['Endfield-aster-20261120-101010.png']);

    o.call('photo.close');
    assert.ok(await until(1, () => (a.last('set_render')!.photo as { active: boolean }).active === false));
    a.socket.destroy();
  } finally {
    o.overlay.stop();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
