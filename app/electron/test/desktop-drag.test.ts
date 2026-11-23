// Panels the user drags by a drag region: rule 7's user offset and the pin in the layout, the follower's drop, reset and
// 复位浮窗 and the panel window's drag.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { DesktopFollow, type FollowPanel, type OffsetStore } from '../src/common/desktop-follow.ts';
import {
  type AnchorPayload, keepOutOf, offsetFrame, type PanelRequest, place, type UserOffset, userOffset, ZERO_INSETS,
} from '../src/common/desktop-layout.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';
import { DesktopPanel } from '../src/main/desktop/panel.ts';

const main: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1512, h: 982 }, visibleFrame: { x: 0, y: 0, w: 1512, h: 957 } };
const side: ScreenInfo = { id: 2, frame: { x: 1512, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1512, y: 0, w: 1920, h: 1055 } };
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const body = r(600, 100, 200, 400);
const bubble = (o: Partial<PanelRequest> = {}): PanelRequest => ({ kind: 'bubble', size: { w: 380, h: 200 }, cardInsets: ZERO_INSETS, visible: true, ...o });

test('a drop keeps the side with the widest gap from her keep-out, measured along from her head', () => {
  const k = keepOutOf('bubble', body, r(700, 500, 0, 0), 1);
  assert.deepEqual(k, r(640, 92, 120, 416));
  const o = userOffset(r(900, 300, 380, 200), k, r(700, 500, 0, 0));
  assert.deepEqual(o, { side: 'right', gap: 140, along: -200 });
  assert.deepEqual(offsetFrame(o, { w: 380, h: 200 }, k, r(700, 500, 0, 0)), r(900, 300, 380, 200));
  assert.deepEqual(offsetFrame({ side: 'below', gap: 20, along: -100 }, { w: 352, h: 80 }, k, r(700, 500, 0, 0)), r(600, -8, 352, 80));
});

test('rule 7: a user offset places the panel there, kept on screen; one whose card lands on her takes the default slot', () => {
  const at = (userOffsetOf: UserOffset) => place({ body, screens: [main], requests: [bubble({ userOffset: userOffsetOf })] });
  let { placements: p, memory } = at({ side: 'right', gap: 40, along: -150 });
  assert.deepEqual(p.bubble, { frame: r(800, 350, 380, 200), side: 'right', docked: null, far: false });
  assert.deepEqual(memory.bubble, { side: 'right', candidate: null, since: 0, hiddenAt: null });
  ({ placements: p } = at({ side: 'right', gap: 40, along: 500 }));
  assert.deepEqual(p.bubble?.frame, r(800, 749, 380, 200));
  ({ placements: p } = at({ side: 'right', gap: -100, along: -150 }));
  assert.deepEqual(p.bubble?.frame, r(768, 300, 380, 200));
  // The dock takes its offset as well.
  ({ placements: p } = place({ body, screens: [main], requests: [{ kind: 'dock', size: { w: 212, h: 188 }, cardInsets: ZERO_INSETS, visible: true,
    userOffset: { side: 'right', gap: 40, along: -150 } }] }));
  assert.deepEqual(p.dock, { frame: r(796, 350, 212, 188), side: 'right', docked: null, far: false });
});

test('a pinned panel sits at its top-left, far from her, and the dock does not lift it', () => {
  const { placements: p } = place({ body, screens: [main], requests: [bubble({ pin: { x: 100, y: 900 } }),
    { kind: 'dock', size: { w: 212, h: 188 }, cardInsets: ZERO_INSETS, visible: true }] });
  assert.deepEqual(p.bubble, { frame: r(100, 700, 380, 200), side: 'left', docked: null, far: true });
});

class Panel implements FollowPanel {
  isShown = true;
  isFrozen = false;
  isKey = false;
  isDragging = false;
  contentSize = { w: 380, h: 200 };
  cardInsets = ZERO_INSETS;
  moves: { frame: Rect; animated: boolean }[] = [];
  anchors: AnchorPayload[] = [];
  move(frame: Rect, animated: boolean) { this.moves.push({ frame, animated }); }
  setAlpha() {}
  pushAnchor(anchor: AnchorPayload) { this.anchors.push(anchor); }
  takeKey() {}
  releaseKey() {}
}

class Offsets implements OffsetStore {
  saved = new Map<string, UserOffset>();
  get(kind: string) { return this.saved.get(kind) ?? null; }
  set(kind: string, o: UserOffset) { this.saved.set(kind, o); }
  clear(kind: string) { this.saved.delete(kind); }
}

function sample(b: Rect | null, now: number, screens: ScreenInfo[] = [main]) {
  return { body: b, bodyAt: b ? now : null, hidden: false, frontFullscreen: false, dragging: false, now, screens, placement: null,
    figure: 'si/default', visual: null };
}

function dragged() {
  const b = new Panel(), offsets = new Offsets();
  const f = new DesktopFollow({ bubble: b }, () => {}, () => {}, () => {}, offsets);
  f.tick(sample(body, 0), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1)?.frame, r(768, 300, 380, 200));
  return { b, f, offsets };
}

test('a drop next to the default slot snaps back to it and keeps no offset', () => {
  const { b, f, offsets } = dragged();
  offsets.set('bubble', { side: 'right', gap: 50, along: 0 });
  f.userMoved('bubble', r(776, 305, 380, 200));
  assert.equal(offsets.get('bubble'), null);
  f.tick(sample(body, 0.1), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1), { frame: r(768, 300, 380, 200), animated: true });
});

test('a drop beside her keeps its gap, at most 96, and the panel follows her with it', () => {
  const { b, f, offsets } = dragged();
  f.userMoved('bubble', r(900, 330, 380, 200));
  assert.deepEqual(offsets.get('bubble'), { side: 'right', gap: 96, along: -170 });
  f.tick(sample(body, 0.1), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1)?.frame, r(856, 330, 380, 200));
  // She walks 300 to the left: the panel keeps the offset from her new box.
  for (let t = 0.2; t < 3; t += 0.1) f.tick(sample(r(300, 100, 200, 400), t), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1)?.frame, r(556, 330, 380, 200));
});

test('a drop more than 400 from her pins the panel until it is reset or she stands on another display', () => {
  const { b, f, offsets } = dragged();
  f.userMoved('bubble', r(1120, 800, 380, 200));
  assert.equal(offsets.get('bubble'), null);
  // The user left it there: it is not moved, and its page points at her from afar.
  f.tick(sample(body, 0.1), { x: 0, y: 0 });
  assert.equal(b.moves.length, 1);
  assert.equal(b.anchors.at(-1)?.far, true);
  f.resetOffset('bubble');
  f.tick(sample(body, 0.2), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1)?.frame, r(768, 300, 380, 200));
  f.userMoved('bubble', r(1120, 800, 380, 200));
  f.tick(sample(body, 0.3), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1)?.frame, r(768, 300, 380, 200));
  for (let t = 0.4; t < 3; t += 0.1) f.tick(sample(r(2000, 100, 200, 400), t, [main, side]), { x: 0, y: 0 });
  assert.notDeepEqual(b.moves.at(-1)?.frame, r(1120, 800, 380, 200));
  assert.ok(b.moves.at(-1)!.frame.x > 1512);
});

test('复位浮窗 drops every offset and pin; a panel the user is dragging is not moved', () => {
  const { b, f, offsets } = dragged();
  f.userMoved('bubble', r(900, 330, 380, 200));
  f.tick(sample(body, 0.1), { x: 0, y: 0 });
  const moves = b.moves.length;
  b.isDragging = true;
  f.resetOffsets();
  assert.equal(offsets.get('bubble'), null);
  f.tick(sample(body, 0.2), { x: 0, y: 0 });
  assert.equal(b.moves.length, moves);
});

/** A BrowserWindow with the calls DesktopPanel makes, and its contents' `before-mouse-event`. */
function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), { id: 7, send() {}, isDestroyed: () => false });
  let bounds = { x: 0, y: 0, width: 100, height: 100 };
  const setBounds: { x: number; y: number; width: number; height: number }[] = [];
  const win = Object.assign(new EventEmitter(), {
    webContents: contents, setFocusable() {}, loadURL: async () => {}, getBounds: () => bounds, isDestroyed: () => false,
    isFocused: () => false, showInactive() {}, hide() {}, setIgnoreMouseEvents() {}, setOpacity() {}, focus() {}, destroy() {},
    setBounds(b: typeof bounds) { bounds = b; setBounds.push(b); },
  });
  return { win, contents, setBounds };
}

test('the panel window: a mouse down in a drag region moves it with the pointer, not the page; a double click resets it', () => {
  const { win, contents, setBounds } = fakeWindow();
  let mouse = { x: 500, y: 500 };
  // DIPs on a 1000 pt high screen: y flips.
  const toDip = (f: Rect) => ({ x: f.x, y: 1000 - f.y - f.h, width: f.w, height: f.h });
  const p = new DesktopPanel({ kind: 'bubble', route: '/bubble', url: 'app://x', aliveOn: 'window.onAnchor',
    makeWindow: () => win as unknown as BrowserWindow, toDip, cursor: () => ({ x: 0, y: 0 }), mouse: () => mouse, register() {}, unregister() {},
    log() {} });
  const moved: Rect[] = [];
  let resets = 0;
  p.onUserMoved = (f) => moved.push(f);
  p.onResetOffset = () => { resets += 1; };
  p.start();
  p.setInteractiveRegions([{ x: 10, y: 10, width: 200, height: 20, drag: true }, { x: 10, y: 40, width: 200, height: 100, drag: false }], []);
  p.move(r(400, 600, 380, 200), false);
  const event = (type: string, x: number, y: number, clickCount = 1) => {
    let prevented = false;
    contents.emit('before-mouse-event', { preventDefault: () => { prevented = true; } }, { type, button: 'left', x, y, clickCount });
    return prevented;
  };
  // A press on the page's other region reaches the page.
  assert.equal(event('mouseDown', 50, 60), false);
  assert.equal(p.isDragging, false);
  event('mouseUp', 50, 60);
  assert.equal(event('mouseDown', 50, 20), true);
  assert.equal(p.isDragging, true);
  mouse = { x: 530, y: 480 };
  assert.equal(event('mouseMove', 50, 20), true);
  assert.deepEqual(setBounds.at(-1), { x: 430, y: 220, width: 380, height: 200 });
  assert.equal(event('mouseUp', 50, 20), true);
  assert.equal(p.isDragging, false);
  assert.deepEqual(moved, [r(430, 580, 380, 200)]);
  // A press and release without travel is no move.
  event('mouseDown', 50, 20);
  event('mouseUp', 50, 20);
  assert.equal(moved.length, 1);
  assert.equal(event('mouseDown', 50, 20, 2), true);
  assert.equal(resets, 1);
  assert.equal(p.isDragging, false);
});
