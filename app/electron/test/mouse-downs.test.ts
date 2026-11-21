// The mouse-down source over the helper's `input.watch` (src/main/attention/mouse-downs.ts), on a fake helper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { MouseDowns } from '../src/main/attention/mouse-downs.ts';

function setup(answer: HelperAnswer = { ok: true, result: { watching: true } }) {
  const requests: [string, Record<string, unknown>][] = [];
  const logs: string[] = [];
  let cursor = { x: 10, y: 20 }, now = 5;
  const downs = new MouseDowns({
    helper: { request: async (op, params = {}) => { requests.push([op, params]); return answer; } },
    cursor: () => cursor, now: () => now, log: (line) => logs.push(line),
  });
  return { downs, requests, logs, move: (p: { x: number; y: number }, t: number) => { cursor = p; now = t; } };
}

test('mouse downs: input.watch once the helper is up, not again after it restarts (the supervisor replays it)', async () => {
  const t = setup();
  t.downs.helper(true);
  await new Promise((r) => setImmediate(r));
  t.downs.helper(false);
  t.downs.helper(true);
  assert.deepEqual(t.requests, [['input.watch', { enabled: true }]]);
});

test('mouse downs: a refused watch is logged once and asked for again at the next hello', async () => {
  const t = setup({ ok: false, error: { code: 'permission_denied' } } as HelperAnswer);
  t.downs.helper(true);
  await new Promise((r) => setImmediate(r));
  t.downs.helper(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.requests.length, 2);
  assert.deepEqual(t.logs, ['MOUSE input.watch failed code=permission_denied']);
});

test('mouse downs: each `mouse_down` reaches the listeners with the pointer and the time; keys and scrolls do not', () => {
  const t = setup();
  const seen: unknown[] = [];
  const off = t.downs.on((at, ts) => seen.push([at, ts]));
  t.downs.event('input.activity', { kind: 'key' });
  t.downs.event('input.activity', { kind: 'scroll' });
  t.downs.event('workspace.changed', { kind: 'mouse_down' });
  t.move({ x: 300, y: 400 }, 7);
  t.downs.event('input.activity', { kind: 'mouse_down' });
  off();
  t.downs.event('input.activity', { kind: 'mouse_down' });
  assert.deepEqual(seen, [[{ x: 300, y: 400 }, 7]]);
});

test('mouse downs: buttonsDown holds from `mouse_down` to `mouse_up` once the helper has sent a `mouse_up`; not before, nor after the helper goes', async () => {
  const t = setup();
  const seen: unknown[] = [];
  t.downs.on((at, ts) => seen.push([at, ts]));
  t.downs.helper(true);
  await new Promise((r) => setImmediate(r));
  t.downs.event('input.activity', { kind: 'mouse_down' });
  assert.equal(t.downs.buttonsDown, false, 'a helper that sends no `mouse_up` leaves a press a press');
  t.downs.event('input.activity', { kind: 'mouse_up' });
  assert.equal(t.downs.buttonsDown, false);
  t.downs.event('input.activity', { kind: 'mouse_down' });
  assert.equal(t.downs.buttonsDown, true);
  t.downs.event('input.activity', { kind: 'key' });
  assert.equal(t.downs.buttonsDown, true);
  t.downs.event('input.activity', { kind: 'mouse_up' });
  assert.equal(t.downs.buttonsDown, false);
  assert.equal(seen.length, 2, 'a release is not a press');
  t.downs.event('input.activity', { kind: 'mouse_down' });
  t.downs.helper(false);
  assert.equal(t.downs.buttonsDown, false, 'the helper went');
  t.downs.helper(true);
  t.downs.event('input.activity', { kind: 'mouse_down' });
  assert.equal(t.downs.buttonsDown, false, 'the new helper has sent no `mouse_up` yet');
});
