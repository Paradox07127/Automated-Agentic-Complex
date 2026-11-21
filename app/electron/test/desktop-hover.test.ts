// The pointer resting on her (src/common/desktop-hover.ts) with the cases and values of DesktopInteractionTests'
// testHoverDwellAndGraceAllowReachingTheHint, HostLinkTests' CapsuleTests and HostLink.avatarHovered's conditions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvatarHover, avatarHovered, capsuleHit, DesktopHover } from '../src/common/desktop-hover.ts';

test('hover: a 0.12 s dwell before it counts, and 0.35 s of grace to reach the hint', () => {
  const hover = new DesktopHover();
  assert.equal(hover.update(true, 0), false);
  assert.equal(hover.update(true, 0.1), false);
  assert.equal(hover.update(true, 0.13), true);
  assert.equal(hover.update(true, 0.5), true);
  assert.equal(hover.update(false, 0.7), true);
  assert.equal(hover.update(true, 0.8), true);
  assert.equal(hover.update(false, 1.2), false);
  hover.reset();
  assert.equal(hover.update(false, 2), false);
});

test('capsule hit: on the segment, and within r of either end or its side', () => {
  const capsule = { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, r: 10 };
  assert.equal(capsuleHit({ x: 0, y: 40 }, [capsule]), true);
  assert.equal(capsuleHit({ x: 0, y: 109.9 }, [capsule]), true);
  assert.equal(capsuleHit({ x: 0, y: 110.1 }, [capsule]), false);
  assert.equal(capsuleHit({ x: -9.9, y: 50 }, [capsule]), true);
  assert.equal(capsuleHit({ x: 10.1, y: 50 }, [capsule]), false);
  assert.equal(capsuleHit({ x: 0, y: 40 }, []), false);
});

test('avatarHovered: a fresh capsule hit while she shows, is not dragged and does not click through', () => {
  const on = { hit: true, age: 0.2, hidden: false, dragging: false, clickThroughAll: false };
  assert.equal(avatarHovered(on), true);
  assert.equal(avatarHovered({ ...on, hit: false }), false);
  assert.equal(avatarHovered({ ...on, age: 0.51 }), false, 'capsules older than 0.5 s');
  assert.equal(avatarHovered({ ...on, age: null }), false, 'no capsules yet');
  assert.equal(avatarHovered({ ...on, hidden: true }), false);
  assert.equal(avatarHovered({ ...on, dragging: true }), false);
  assert.equal(avatarHovered({ ...on, clickThroughAll: true }), false);
});

test('avatarHovered: not while her character switches, nor with a button down unless her last cursor was a hit', () => {
  const on = { hit: true, age: 0.2, hidden: false, dragging: false, clickThroughAll: false, switching: false, buttonsDown: false,
    lastCursorHit: false };
  assert.equal(avatarHovered(on), true);
  assert.equal(avatarHovered({ ...on, switching: true }), false, 'a set_character in flight');
  assert.equal(avatarHovered({ ...on, buttonsDown: true }), false, 'a press that began off her');
  assert.equal(avatarHovered({ ...on, buttonsDown: true, lastCursorHit: true }), true, 'a press on her');
  assert.equal(avatarHovered({ ...on, lastCursorHit: true, hit: false }), false);
});

test('AvatarHover: DesktopInteraction.tick for the web panels — hints off or no body resets it; changes only are reported', () => {
  const h = new AvatarHover();
  const seen: boolean[] = [];
  h.onChange = (v) => seen.push(v);
  const s = { present: true, hovered: true, hints: true };
  h.tick(s, 0);
  h.tick(s, 0.13);
  h.tick(s, 0.2);
  assert.equal(h.hovered, true);
  h.tick({ ...s, hovered: false }, 0.3);
  assert.equal(h.hovered, true, 'within the grace');
  h.tick({ ...s, present: false }, 0.31);
  assert.equal(h.hovered, false, 'no body: off at once');
  h.tick(s, 0.32);
  h.tick(s, 0.4);
  assert.equal(h.hovered, false, 'the dwell starts again after a reset');
  h.tick(s, 0.45);
  assert.equal(h.hovered, true);
  h.tick({ ...s, hints: false }, 0.5);
  h.tick({ ...s, hints: false }, 0.9);
  assert.equal(h.hovered, false, 'hover hints off');
  assert.deepEqual(seen, [true, false, true, false]);
});
