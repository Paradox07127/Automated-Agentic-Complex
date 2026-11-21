// The press-made keep-clear sources (`control`, `near_clicks`), CursorKinematics.click's 10 s count for `near_clicks_10s`,
// and the focus visibility.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOCUS_VISIBILITY, FocusVisibility } from '../src/common/focus-visibility.ts';
import { ControlTargets, KEEP_CLEAR, NEAR_CLICKS, NearClickCells, NearClickCount } from '../src/common/keepclear.ts';

test('near clicks: a 50 pt cell pressed 3 times within 600 s is a target; older presses fall out', () => {
  const cells = new NearClickCells();
  cells.record({ x: 101, y: 160 }, 0);
  cells.record({ x: 149, y: 199 }, 10);
  assert.deepEqual(cells.rects(10), []);
  cells.record({ x: 120, y: 151 }, 20);
  assert.deepEqual(cells.rects(20), [{ x: 100, y: 150, w: 50, h: 50 }]);
  assert.deepEqual(cells.rects(NEAR_CLICKS.window), [], 'the first press is 600 s old');
  cells.record({ x: -1, y: -1 }, 30);
  cells.record({ x: -1, y: -1 }, 31);
  cells.record({ x: -49, y: -1 }, 32);
  assert.deepEqual(cells.rects(40), [{ x: 100, y: 150, w: 50, h: 50 }, { x: -50, y: -50, w: 50, h: 50 }], 'cells round down');
});

test('near clicks: at most 64 cells, the least recently pressed dropped first', () => {
  const cells = new NearClickCells();
  for (let i = 0; i < 3; i += 1) cells.record({ x: 0, y: 0 }, i);
  for (let i = 1; i <= NEAR_CLICKS.maxCells - 1; i += 1) cells.record({ x: i * 50, y: 0 }, 10);
  assert.equal(cells.rects(10).length, 1);
  cells.record({ x: 0, y: 500 }, 11);
  assert.deepEqual(cells.rects(11), [], 'the 65th cell pushes out the oldest');
});

test('control: a pass-through rect counts after a 1 s hover or at once on a press, and is kept 10 s', () => {
  const button = { x: 10, y: 10, w: 40, h: 20 }, other = { x: 100, y: 10, w: 40, h: 20 };
  const c = new ControlTargets();
  c.update({ x: 20, y: 15 }, [button], false, 0);
  c.update({ x: 20, y: 15 }, [button], false, KEEP_CLEAR.controlHover - 0.1);
  assert.deepEqual(c.rects, []);
  c.update({ x: 20, y: 15 }, [button], false, KEEP_CLEAR.controlHover);
  assert.deepEqual(c.rects, [button]);
  c.update({ x: 0, y: 0 }, [button], false, 2);
  c.update({ x: 110, y: 15 }, [button, other], true, 3);
  assert.deepEqual(c.rects, [button, other], 'a press counts at once');
  c.update({ x: 0, y: 0 }, [button, other], false, KEEP_CLEAR.controlHover + KEEP_CLEAR.controlKeep);
  assert.deepEqual(c.rects, [other], 'the hovered one is 10 s old');
  c.update({ x: 0, y: 0 }, [], false, 3 + KEEP_CLEAR.controlKeep);
  assert.deepEqual(c.rects, []);
});

test('control: leaving the rect restarts its hover', () => {
  const button = { x: 10, y: 10, w: 40, h: 20 };
  const c = new ControlTargets();
  c.update({ x: 20, y: 15 }, [button], false, 0);
  c.update({ x: 0, y: 0 }, [button], false, 0.5);
  c.update({ x: 20, y: 15 }, [button], false, 0.6);
  c.update({ x: 20, y: 15 }, [button], false, 1.5);
  assert.deepEqual(c.rects, []);
  c.update({ x: 20, y: 15 }, [button], false, 1.6);
  assert.deepEqual(c.rects, [button]);
});

test('near_clicks_10s: presses off her and within 120 pt of her bounds, for 10 s', () => {
  const n = new NearClickCount();
  const body = { x: 500, y: 100, w: 200, h: 400 };
  n.click(0, { x: 400, y: 200 }, body, false);
  n.click(1, { x: 600, y: 200 }, body, true);
  n.click(2, { x: 379, y: 200 }, body, false);
  n.click(3, { x: 380, y: 200 }, null, false);
  n.click(4, { x: 780, y: 580 }, body, false);
  assert.equal(n.count(5), 2);
  assert.equal(n.count(10), 1, 'the first is 10 s old');
});

test('focus visibility: hides after 1.2 s covered, shows 0.8 s after clear but not before 3 s hidden', () => {
  const f = new FocusVisibility();
  assert.equal(f.update(true, 0, false), null);
  assert.equal(f.update(true, FOCUS_VISIBILITY.enterDelay - 0.01, false), null);
  assert.equal(f.update(true, FOCUS_VISIBILITY.enterDelay, false), false);
  assert.equal(f.hidden, true);
  assert.equal(f.update(false, 1.5, false), null);
  assert.equal(f.update(false, 2.5, false), null, 'clear 1 s, hidden only 1.3 s');
  assert.equal(f.update(false, 4.2, false), true);
  assert.equal(f.hidden, false);
});

test('focus visibility: interacting or a manual change holds it off for 3 s', () => {
  const f = new FocusVisibility();
  f.update(true, 0, false);
  assert.equal(f.update(true, 1, true), null);
  assert.equal(f.update(true, 3.9, false), null, 'within the grace after interacting');
  assert.equal(f.update(true, 4, false), null, 'the covered run starts again');
  assert.equal(f.update(true, 5.2, false), false);
  f.manual(6);
  assert.equal(f.hidden, false);
  assert.equal(f.update(true, 8.9, false), null);
  assert.equal(f.update(true, 9, false), null);
  assert.equal(f.update(true, 10.3, false), false);
});
