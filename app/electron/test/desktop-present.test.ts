// C3 rule 39's presents in the follower (src/common/desktop-follow.ts): a presented panel is held until her stroke or 3.5 s after its
// `open`, and its close is done at her stroke, 1.5 s after it, or when the panel went.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnchorPayload } from '../src/common/desktop-layout.ts';
import { DesktopFollow, type FollowPanel, PRESENT_CLOSE_WAIT, PRESENT_OPEN_WAIT } from '../src/common/desktop-follow.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';

const main: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1512, h: 982 }, visibleFrame: { x: 0, y: 0, w: 1512, h: 957 } };
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const body = r(600, 100, 200, 400);

class Panel implements FollowPanel {
  isShown = true;
  isFrozen = false;
  isKey = false;
  contentSize = { w: 380, h: 200 };
  cardInsets = null;
  moves: Rect[] = [];
  move(frame: Rect) { this.moves.push(frame); }
  pushAnchor(_anchor: AnchorPayload) {}
  takeKey() {}
  releaseKey() {}
}

function setup(reaches = true) {
  const b = new Panel();
  const f = new DesktopFollow({ bubble: b });
  const presents: string[] = [], closed: string[] = [];
  f.onPresent = (token, side, open) => {
    presents.push(`${token} ${side} ${open ? 'open' : 'close'}`);
    return reaches;
  };
  f.onPresentClosed = (kind) => closed.push(kind);
  const tick = (now: number) => f.tick({ body, bodyAt: now, hidden: false, frontFullscreen: false, dragging: false, now, screens: [main],
    placement: null, figure: 'si/default', visual: null }, { x: 0, y: 0 });
  return { b, f, presents, closed, tick };
}

test('a presented panel sends open with its side once laid out, and is placed only at her stroke', () => {
  const { b, f, presents, tick } = setup();
  assert.equal(f.present('bubble', 't1'), true);
  assert.equal(f.present('bubble', 't2'), false, 'one present a panel');
  tick(0);
  assert.deepEqual(presents, ['t1 right open']);
  assert.deepEqual(b.moves, []);
  tick(1);
  f.stroke('other');
  tick(1.1);
  assert.deepEqual(b.moves, []);
  f.stroke('t1');
  tick(1.2);
  assert.deepEqual(b.moves, [r(752, 322, 380, 200)]);
  assert.deepEqual(presents, ['t1 right open']);
  // A panel already placed presents nothing.
  assert.equal(f.present('bubble', 't3'), false);
});

test('without her stroke the panel shows anyway after 3.5 s; one whose open did not reach her shows at once', () => {
  const late = setup();
  late.f.present('bubble', 't1');
  late.tick(0);
  late.tick(PRESENT_OPEN_WAIT - 0.1);
  assert.deepEqual(late.b.moves, []);
  late.tick(PRESENT_OPEN_WAIT);
  assert.equal(late.b.moves.length, 1);
  const lost = setup(false);
  lost.f.present('bubble', 't1');
  lost.tick(0);
  assert.deepEqual(lost.presents, ['t1 right open']);
  assert.equal(lost.b.moves.length, 1);
});

test('a dismissed present sends close and is done at her stroke, 1.5 s later, or once the panel went', () => {
  const { b, f, presents, closed, tick } = setup();
  f.present('bubble', 't1');
  tick(0);
  f.stroke('t1');
  tick(0.1);
  assert.equal(f.dismissPresent('bubble'), true);
  assert.equal(f.dismissPresent('bubble'), true, 'still closing');
  assert.deepEqual(presents, ['t1 right open', 't1 right close']);
  f.stroke('t1');
  assert.deepEqual(closed, ['bubble']);
  assert.equal(f.dismissPresent('bubble'), false, 'gone');

  const wait = setup();
  wait.f.present('bubble', 't1');
  wait.tick(0);
  wait.f.dismissPresent('bubble');
  wait.tick(1);
  wait.tick(1 + PRESENT_CLOSE_WAIT - 0.1);
  assert.deepEqual(wait.closed, []);
  wait.tick(1 + PRESENT_CLOSE_WAIT);
  assert.deepEqual(wait.closed, ['bubble']);

  const hidden = setup();
  hidden.f.present('bubble', 't1');
  hidden.tick(0);
  hidden.f.dismissPresent('bubble');
  hidden.b.isShown = false;
  hidden.tick(0.1);
  assert.deepEqual(hidden.closed, ['bubble']);
  assert.equal(b.moves.length, 1);
});

test('a present whose open has not gone out is dropped by a dismiss; an opened one whose panel went sends close', () => {
  const early = setup();
  early.b.isShown = false;
  early.f.present('bubble', 't1');
  early.tick(0);
  assert.equal(early.f.dismissPresent('bubble'), false);
  assert.deepEqual(early.presents, []);
  const went = setup();
  went.f.present('bubble', 't1');
  went.tick(0);
  went.b.isShown = false;
  went.tick(0.1);
  assert.deepEqual(went.presents, ['t1 right open', 't1 right close']);
  assert.deepEqual(went.closed, []);
  assert.equal(went.f.dismissPresent('bubble'), false);
});
