// The pointer on her (src/common/desktop-hover.ts): the capsule hit grown by the enter and keep margins, HostLink.avatarHovered's
// conditions, and the hover buttons' dead zone — 300 ms to open, 600 ms of grace, the corridor and the safe triangle to the
// buttons. Rects are in the placement space (y up), times in seconds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AIM_REST, avatarHovered, type Capsule, capsuleHit, DOCK_IDLE, dockOpen, type DockState, dockStep, ENTER_GROW, HOVER_DWELL, HOVER_GRACE,
  KEEP_GROW,
} from '../src/common/desktop-hover.ts';
import type { Rect } from '../src/common/placement.ts';

test('capsule hit: on the segment, and within r of either end or its side', () => {
  const capsule = { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, r: 10 };
  assert.equal(capsuleHit({ x: 0, y: 40 }, [capsule]), true);
  assert.equal(capsuleHit({ x: 0, y: 109.9 }, [capsule]), true);
  assert.equal(capsuleHit({ x: 0, y: 110.1 }, [capsule]), false);
  assert.equal(capsuleHit({ x: -9.9, y: 50 }, [capsule]), true);
  assert.equal(capsuleHit({ x: 10.1, y: 50 }, [capsule]), false);
  assert.equal(capsuleHit({ x: 0, y: 40 }, []), false);
});

test('capsule hit: grown by the enter margin, 12, and the keep margin, 24', () => {
  const capsule = { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, r: 10 };
  assert.equal(capsuleHit({ x: 21.9, y: 50 }, [capsule], ENTER_GROW), true);
  assert.equal(capsuleHit({ x: 22.1, y: 50 }, [capsule], ENTER_GROW), false);
  assert.equal(capsuleHit({ x: 0, y: 133.9 }, [capsule], KEEP_GROW), true);
  assert.equal(capsuleHit({ x: 34.1, y: 50 }, [capsule], KEEP_GROW), false);
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

// Her torso, 80 wide, and a thin leg under it; her box is x 60–140, y −113–240.
const TORSO: Capsule = { a: { x: 100, y: 100 }, b: { x: 100, y: 200 }, r: 40 };
const LEG: Capsule = { a: { x: 100, y: -100 }, b: { x: 100, y: 60 }, r: 13 };
const BODY: Rect = { x: 60, y: -113, w: 80, h: 353 };
/** The buttons on her right, 16 out from her box. */
const RIGHT: Rect = { x: 156, y: -60, w: 196, h: 156 };
/** The buttons above her, 16 over her box. */
const ABOVE: Rect = { x: 40, y: 256, w: 196, h: 156 };
const ON_HER = { x: 100, y: 150 };
const AWAY = { x: 600, y: 600 };
const TICK = 1 / 30;

/** Feeds `dockStep` the samples the assembly would: the grown hits on her capsules, her box and the buttons' card. */
function hover(dock: Rect | null = RIGHT) {
  let s: DockState = DOCK_IDLE;
  const at = (p: { x: number; y: number }, now: number, o: { blocked?: boolean; held?: boolean; dock?: Rect | null } = {}) => {
    s = dockStep(s, { p, enter: capsuleHit(p, [TORSO, LEG], ENTER_GROW), keep: capsuleHit(p, [TORSO, LEG], KEEP_GROW), body: BODY,
      dock: o.dock === undefined ? dock : o.dock, blocked: o.blocked ?? false, held: o.held ?? false }, now);
    return s;
  };
  /** The same point every tick from `from`, and once more at `to`. */
  const rest = (p: { x: number; y: number }, from: number, to: number, o: { blocked?: boolean; held?: boolean } = {}) => {
    for (let t = from; t < to; t += TICK) at(p, t, o);
    return at(p, to, o);
  };
  return { at, rest, get state() { return s; } };
}

/** Open after resting on her from 0 to the dwell. */
function opened(dock: Rect | null = RIGHT) {
  const h = hover(dock);
  h.rest(ON_HER, 0, HOVER_DWELL);
  assert.equal(dockOpen(h.state), true);
  return h;
}

test('dead zone: the pointer passing over her does not open the buttons', () => {
  const h = hover();
  // Across her at about 800 px/s: inside her enter zone for well under the dwell.
  for (let i = 0; i <= 12; i += 1) h.at({ x: 20 + i * 27, y: 150 }, i * TICK);
  h.rest(AWAY, 13 * TICK, 1);
  assert.equal(dockOpen(h.state), false);
  assert.equal(h.state.phase, 'idle');
});

test('dead zone: resting 300 ms within 12 px of her opens the buttons', () => {
  const h = hover();
  h.rest({ x: 150, y: 150 }, 0, HOVER_DWELL - 0.05);
  assert.equal(h.state.phase, 'arming', 'within 12 px of her torso, not yet the dwell');
  h.at({ x: 150, y: 150 }, HOVER_DWELL);
  assert.equal(h.state.phase, 'open');
});

test('dead zone: the dwell starts only within 12 px, and runs on within 24 px', () => {
  const h = hover();
  h.rest({ x: 158, y: 150 }, 0, 0.5);
  assert.equal(h.state.phase, 'idle', '18 px off her does not start it');
  h.at({ x: 150, y: 150 }, 0.6);
  h.rest({ x: 160, y: 150 }, 0.6 + TICK, 0.6 + HOVER_DWELL + 0.01);
  assert.equal(h.state.phase, 'open', 'started at 10 px, held on at 20 px');
});

test('dead zone: out of the keep zone before the dwell, it starts again', () => {
  const h = hover();
  h.rest(ON_HER, 0, 0.2);
  h.at(AWAY, 0.25);
  assert.equal(h.state.phase, 'idle');
  h.rest(ON_HER, 0.3, 0.55);
  assert.equal(dockOpen(h.state), false, 'the second rest is under the dwell');
});

test('dead zone: away and back within 600 ms keeps the buttons; 600 ms away closes them', () => {
  const h = opened();
  h.rest(AWAY, 0.4, 0.4 + HOVER_GRACE - 0.1);
  assert.equal(h.state.phase, 'leaving');
  assert.equal(dockOpen(h.state), true, 'still shown in the grace');
  h.at(ON_HER, 0.4 + HOVER_GRACE - 0.05);
  assert.equal(h.state.phase, 'open');
  h.rest(AWAY, 1.1, 1.1 + HOVER_GRACE - 0.01);
  assert.equal(dockOpen(h.state), true);
  h.at(AWAY, 1.1 + HOVER_GRACE + 0.01);
  assert.equal(h.state.phase, 'idle');
});

test('dead zone: on the buttons, with 3 px around them, the buttons stay', () => {
  const h = opened();
  h.rest({ x: 300, y: 20 }, 0.4, 2);
  assert.equal(h.state.phase, 'open');
  h.rest({ x: RIGHT.x + RIGHT.w + 2, y: 20 }, 2.1, 3);
  assert.equal(h.state.phase, 'open');
});

test('dead zone: along the corridor from her box to the buttons they stay', () => {
  const h = opened();
  // By her leg, out of its keep zone (13 + 24) but between her box (140) and the buttons (156).
  h.at({ x: 120, y: 0 }, 0.4);
  for (let i = 0; i < 6; i += 1) h.at({ x: 145 + i, y: 0 }, 0.45 + i * TICK);
  assert.equal(h.state.phase, 'open');
  h.at({ x: 160, y: 0 }, 0.7);
  assert.equal(h.state.phase, 'open');
});

test('dead zone: the same point beside the corridor starts the grace', () => {
  const h = opened();
  h.at({ x: 145, y: -105 }, 0.4);
  assert.equal(h.state.phase, 'leaving', 'below the buttons, not between her and them');
});

test('dead zone: heading through the safe triangle to buttons above her keeps them', () => {
  const h = opened(ABOVE);
  // Out of her right side towards the buttons' near edge; the exit point is the last one in her keep zone.
  h.at({ x: 150, y: 180 }, 0.4);
  const path = [{ x: 170, y: 200 }, { x: 185, y: 212 }, { x: 200, y: 230 }, { x: 205, y: 245 }];
  path.forEach((p, i) => h.at(p, 0.4 + (i + 1) * TICK));
  assert.equal(h.state.phase, 'open');
  h.at({ x: 210, y: 258 }, 0.4 + 5 * TICK);
  assert.equal(h.state.phase, 'open', 'on the buttons');
});

test('dead zone: off the safe triangle, between her and the buttons, is a leave', () => {
  const h = opened(ABOVE);
  h.at({ x: 230, y: 200 }, 0.4);
  assert.equal(h.state.phase, 'leaving');
});

test('dead zone: resting 300 ms in the safe triangle ends it, and the grace runs from there', () => {
  const h = opened(ABOVE);
  h.at({ x: 150, y: 180 }, 0.4);
  h.at({ x: 200, y: 230 }, 0.45);
  h.rest({ x: 200, y: 230 }, 0.45 + TICK, 0.45 + AIM_REST - 0.02);
  assert.equal(h.state.phase, 'open', 'still heading there');
  h.rest({ x: 200, y: 230 }, 0.45 + AIM_REST, 0.45 + AIM_REST + 0.05);
  assert.equal(h.state.phase, 'leaving');
  h.at({ x: 201, y: 231 }, 0.45 + AIM_REST + 0.2);
  assert.equal(h.state.phase, 'leaving', 'moving again does not bring the triangle back');
  h.rest({ x: 201, y: 231 }, 0.45 + AIM_REST + 0.25, 0.45 + AIM_REST + HOVER_GRACE + 0.05);
  assert.equal(h.state.phase, 'idle');
});

test('dead zone: dragged, hidden or click-through closes them at once; recording holds them', () => {
  const h = opened();
  h.at(ON_HER, 0.4, { blocked: true });
  assert.equal(h.state.phase, 'idle');
  h.rest(ON_HER, 0.5, 0.5 + HOVER_DWELL, { blocked: true });
  assert.equal(h.state.phase, 'idle', 'nothing opens while blocked');

  const r = opened();
  r.rest(AWAY, 0.4, 3, { held: true });
  assert.equal(r.state.phase, 'open');
  r.at(AWAY, 3.1);
  assert.equal(r.state.phase, 'leaving', 'the grace starts once the recording ends');
});

test('dead zone: before the buttons are placed only her keep zone holds them', () => {
  const h = opened(null);
  h.at({ x: 300, y: 20 }, 0.4);
  assert.equal(h.state.phase, 'leaving');
});
