// Rule 44's colours (src/common/ambient.ts) and the render_ambient setting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AmbientColors, ambientChanged, ambientLinear, ambientMode, ambientWire, reduceAmbient } from '../src/common/ambient.ts';

/** A `side`×`side` RGBA8 image, rows top to bottom, each pixel `at(x, y)`. */
function image(side: number, at: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) out.set(at(x, y), (y * side + x) * 4);
  return out;
}

const grey = (v: number): [number, number, number] => [v, v, v];
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('the sRGB transfer goes linear: straight below 0.04045, the 2.4 power above', () => {
  near(ambientLinear(0), 0);
  near(ambientLinear(0.04045), 0.04045 / 12.92);
  near(ambientLinear(0.5), Math.pow((0.5 + 0.055) / 1.055, 2.4));
  near(ambientLinear(1), 1);
});

test('mean is the whole image, top and bottom the outer third of the rows, left and right of the columns; alpha is ignored', () => {
  // 16 / 3 = 5: the top five rows white, the rest black; alpha 0 everywhere.
  const c = reduceAmbient(image(16, (_x, y) => (y < 5 ? [255, 255, 255, 0] : [0, 0, 0, 0])), 16, 16);
  for (const v of c.top) near(v, 1);
  for (const v of c.bottom) near(v, 0);
  for (const v of c.mean) near(v, 5 / 16);
  for (const v of c.left) near(v, 5 / 16);
  for (const v of c.right) near(v, 5 / 16);
  // The right five columns red: right is red, left none of it.
  const r = reduceAmbient(image(16, (x) => (x >= 11 ? [255, 0, 0, 255] : [0, 0, 0, 255])), 16, 16);
  assert.deepEqual(r.right, [1, 0, 0]);
  assert.deepEqual(r.left, [0, 0, 0]);
  near(r.mean[0], 5 / 16);
});

test('an image under three pixels a side takes one row or column for each side', () => {
  const c = reduceAmbient(image(2, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 2, 2);
  assert.deepEqual(c.top, grey(0.5));
  assert.deepEqual(c.left, grey(0.5));
  assert.deepEqual(c.bottom, grey(0));
  assert.deepEqual(c.right, grey(0));
  assert.deepEqual(c.mean, grey(0.25));
});

test('on the wire each component has at most 3 decimals (C3 rule 44)', () => {
  const c: AmbientColors = { mean: [0.33333, 0.0005, 1], top: [0.4444, 0, 0.9996], bottom: grey(0.1), left: grey(0.2), right: grey(0.3) };
  assert.deepEqual(ambientWire(c), { mean: [0.333, 0.001, 1], top: [0.444, 0, 1], bottom: grey(0.1), left: grey(0.2), right: grey(0.3) });
});

test('a sample is new without a previous one or when any component of any colour moved by more than 0.02', () => {
  const a: AmbientColors = { mean: grey(0.5), top: grey(0.5), bottom: grey(0.5), left: grey(0.5), right: grey(0.5) };
  assert.equal(ambientChanged(null, a), true);
  assert.equal(ambientChanged(a, { ...a, right: [0.5, 0.5, 0.52] }), false);
  assert.equal(ambientChanged(a, { ...a, right: [0.5, 0.5, 0.521] }), true);
  assert.equal(ambientChanged(a, { ...a, bottom: [0.5, 0.479, 0.5] }), true);
});

test('render_ambient is "off" unless saved as a string', () => {
  assert.equal(ambientMode({}), 'off');
  assert.equal(ambientMode({ render_ambient: true }), 'off');
  assert.equal(ambientMode({ render_ambient: 'screen' }), 'screen');
  assert.equal(ambientMode({ render_ambient: 'wallpaper' }), 'wallpaper');
});
