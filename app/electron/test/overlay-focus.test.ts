// A desktop panel's window options (src/main/platform/index.ts `overlayOptions`) and a DesktopPanel on them: on Windows
// unfocusable from the start and shown without activating; 快速输入's panel still takes the keyboard.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { DesktopPanel } from '../src/main/desktop/panel.ts';
import { overlayOptions } from '../src/main/platform/index.ts';

test('overlay: on Windows a panel window is made unfocusable and kept out of the taskbar; on the Mac it is a panel', () => {
  const windows = overlayOptions('windows');
  assert.equal(windows.focusable, false);
  assert.equal(windows.skipTaskbar, true);
  assert.equal(windows.type, undefined);
  const mac = overlayOptions('mac');
  assert.equal(mac.type, 'panel');
  assert.equal(mac.focusable, undefined);
});

/** A window made with `options`, recording its focusable state and the calls that show or focus it. */
function fakeWindow(options: BrowserWindowConstructorOptions) {
  const calls: string[] = [`made focusable ${options.focusable ?? true}`];
  const contents = Object.assign(new EventEmitter(), { id: 7, send() {}, isDestroyed: () => false });
  let bounds = { x: 0, y: 0, width: 100, height: 100 };
  const win = Object.assign(new EventEmitter(), {
    webContents: contents, loadURL: async () => {}, getBounds: () => bounds, isDestroyed: () => false, isFocused: () => false,
    setFocusable: (on: boolean) => calls.push(`focusable ${on}`), showInactive: () => calls.push('showInactive'),
    show: () => calls.push('show'), focus: () => calls.push('focus'), hide() {}, setIgnoreMouseEvents() {}, setOpacity() {}, destroy() {},
    setBounds(b: typeof bounds) { bounds = b; },
  });
  return { win: win as unknown as BrowserWindow, calls };
}

function panel(route: string, win: BrowserWindow) {
  return new DesktopPanel({ kind: route === '/cmd' ? 'cmd' : 'bubble', route, url: 'app://x', aliveOn: 'window.onAnchor',
    makeWindow: () => win, toDip: (f) => ({ x: f.x, y: 1000 - f.y - f.h, width: f.w, height: f.h }),
    cursor: () => ({ x: 0, y: 0 }), mouse: () => ({ x: 0, y: 0 }), register() {}, unregister() {}, log() {} });
}

test('overlay: on Windows her bubble shows without taking focus; 快速输入 turns focusable to take the keyboard', () => {
  const frame = { x: 400, y: 600, w: 380, h: 200 };
  const bubble = fakeWindow(overlayOptions('windows'));
  const b = panel('/bubble', bubble.win);
  b.start();
  b.setCards(['c1']);
  b.move(frame, false);
  assert.deepEqual(bubble.calls, ['made focusable false', 'focusable false', 'showInactive']);
  b.stop();

  const input = fakeWindow(overlayOptions('windows'));
  const q = panel('/cmd', input.win);
  q.start();
  q.takeKey();
  q.setInteractiveRegions([{ x: 0, y: 0, width: 380, height: 60, drag: false }], []);
  q.move(frame, false);
  assert.deepEqual(input.calls, ['made focusable false', 'focusable false', 'showInactive', 'focusable true', 'focus']);
  q.stop();
});
