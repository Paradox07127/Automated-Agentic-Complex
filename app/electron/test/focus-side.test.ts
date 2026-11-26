// `attention_side` with source focus (src/common/focus-side.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOCUS_SIDE, FocusSide } from '../src/common/focus-side.ts';

const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
/** Her body 160 × 400 with its centre at (700, 300). */
const body = r(620, 100, 160, 400);
const farLeft = r(0, 100, 300, 400);
const farRight = r(1200, 100, 300, 400);
const near = r(820, 100, 100, 400);

test('a far window turns her once after three seconds', () => {
  const focus = new FocusSide();
  assert.equal(focus.sample(1, farLeft, body, 0), null);
  assert.equal(focus.sample(1, farLeft, body, FOCUS_SIDE.dwell - 0.1), null);
  assert.equal(focus.sample(1, farLeft, body, FOCUS_SIDE.dwell), 'left');
  assert.equal(focus.sample(1, farLeft, body, 10), null, 'once per focus');
  assert.equal(focus.sample(2, farRight, body, 11), null);
  assert.equal(focus.sample(2, farRight, body, 14), 'right');
});

test('a near window or a quick switch turns her not', () => {
  const focus = new FocusSide();
  assert.equal(focus.sample(1, near, body, 0), null);
  assert.equal(focus.sample(1, near, body, 5), null, 'its centre is 170 pt from hers');
  assert.equal(focus.sample(2, farLeft, body, 6), null);
  assert.equal(focus.sample(3, farLeft, body, 8), null);
  assert.equal(focus.sample(2, farLeft, body, 10), null, 'back to 2 counts afresh');
  assert.equal(focus.sample(2, null, body, 20), null, 'no frame, no side');
});

test('moving the same window rearms only after it settles', () => {
  const focus = new FocusSide();
  assert.equal(focus.sample(1, farLeft, body, 0), null);
  assert.equal(focus.sample(1, farLeft, body, 3), 'left');
  assert.equal(focus.sample(1, farRight, body, 4), null);
  assert.equal(focus.sample(1, near, body, 5), null);
  assert.equal(focus.sample(1, farRight, body, 6), null);
  assert.equal(focus.sample(1, farRight, body, 8.9), null);
  assert.equal(focus.sample(1, farRight, body, 9), 'right');
  assert.equal(focus.sample(1, farRight, body, 15), null);
});

test('typing turns her to the focused window at most every three minutes', () => {
  const focus = new FocusSide();
  assert.equal(focus.typing(0), null, 'no focused window yet');
  focus.sample(1, near, body, 0);
  assert.equal(focus.typing(1), 'right');
  assert.equal(focus.typing(1 + FOCUS_SIDE.typingInterval - 1), null);
  assert.equal(focus.typing(1 + FOCUS_SIDE.typingInterval), 'right');
});

test('an unavailable host does not consume the current focus or typing signal', () => {
  const focus = new FocusSide();
  focus.sample(1, farLeft, body, 0);
  assert.equal(focus.sample(1, farLeft, body, 3, () => false), null);
  assert.equal(focus.sample(1, farLeft, body, 5), 'left');
  assert.equal(focus.sample(1, farLeft, body, 6), null);
  assert.equal(focus.typing(6, () => false), null);
  assert.equal(focus.typing(7), 'left');
  assert.equal(focus.typing(8), null);
});
