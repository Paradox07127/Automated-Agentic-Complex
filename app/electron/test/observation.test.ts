// The shell's observation state (src/common/desktop-action.ts, src/main/ops/observation.ts): agentd's `GET /state` `observation`, quiet set through `PUT /observation/quiet`, and
// `desktop.onState`'s `quietUntil`. agentd is a fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { BridgeFailure } from '../src/common/bridge.ts';
import { activeQuietUntil, observationState } from '../src/common/desktop-action.ts';
import { checkRequest, RouteTable } from '../src/common/routes.ts';
import { ObservationControl } from '../src/main/ops/observation.ts';

const QUIET = '2026-11-20T10:30:00.000+08:00';
const PAUSED = '2026-11-20T10:00:00.000+08:00';

test('observation of a /state body: ISO times with fractional seconds, absent keys as off; none without an object', () => {
  assert.deepEqual(observationState({ observation: { paused_until: PAUSED, meeting: true, off: false, quiet_until: QUIET } }),
    { pausedUntil: Date.parse(PAUSED), meeting: true, off: false, quietUntil: Date.parse(QUIET) });
  assert.deepEqual(observationState({ observation: {} }), { pausedUntil: null, meeting: false, off: false, quietUntil: null });
  assert.deepEqual(observationState({ observation: { quiet_until: '2026-11-20T10:30:00+08:00', paused_until: 7, meeting: 'yes' } }),
    { pausedUntil: null, meeting: false, off: false, quietUntil: null });
  assert.equal(observationState({ epoch: 1 }), null);
  assert.equal(observationState({ observation: [] }), null);
  assert.equal(observationState(null), null);
});

test('quiet counts only until its end', () => {
  const at = Date.parse(QUIET);
  const s = { pausedUntil: null, meeting: true, off: false, quietUntil: at };
  assert.equal(activeQuietUntil(s, at - 1), at);
  assert.equal(activeQuietUntil(s, at), null);
  assert.equal(activeQuietUntil({ ...s, quietUntil: null }, 0), null);
});

function agentd(replies: Record<string, { status: number; body: unknown }>) {
  const calls: [string, string, unknown][] = [];
  return {
    calls,
    request: async (method: string, path: string, json?: unknown) => {
      calls.push([method, path, json]);
      const r = replies[`${method} ${path}`];
      if (!r) throw new Error('agentd is not running');
      return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
    },
  };
}

test('load reads GET /state; a failed read leaves the state as it was', async () => {
  const a = agentd({ 'GET /state': { status: 200, body: { observation: { paused_until: null, meeting: false, off: false, quiet_until: QUIET } } } });
  const o = new ObservationControl({ request: a.request, now: () => Date.parse(QUIET) - 60_000 });
  assert.equal(o.quietUntil(), null);
  await o.load();
  assert.equal(o.quietUntil(), Date.parse(QUIET));
  for (const reply of [{ status: 503, body: { error: 'starting' } }, { status: 200, body: 'not json' }, { status: 200, body: { epoch: 1 } }]) {
    let first = true;
    const b = agentd({ 'GET /state': reply });
    const kept = new ObservationControl({ request: (m, p, j) => (first ? a.request(m, p, j) : b.request(m, p, j)), now: () => 0 });
    await kept.load();
    first = false;
    await kept.load();
    assert.equal(kept.state.quietUntil, Date.parse(QUIET), JSON.stringify(reply));
  }
  const down = new ObservationControl({ request: agentd({}).request, now: () => 0 });
  await down.load();
  assert.deepEqual(down.state, { pausedUntil: null, meeting: false, off: false, quietUntil: null });
});

test('setQuiet puts the end in epoch seconds or null, keeps agentd\'s quiet_until, then reads /state again', async () => {
  const a = agentd({
    'PUT /observation/quiet': { status: 200, body: { quiet_until: QUIET } },
    'GET /state': { status: 200, body: { observation: { paused_until: PAUSED, meeting: true, off: false, quiet_until: QUIET } } },
  });
  const o = new ObservationControl({ request: a.request, now: () => 0 });
  await o.setQuiet(1_800_000_000);
  assert.deepEqual(a.calls, [['PUT', '/observation/quiet', { until: 1_800_000_000 }], ['GET', '/state', undefined]]);
  assert.deepEqual(o.state, { pausedUntil: Date.parse(PAUSED), meeting: true, off: false, quietUntil: Date.parse(QUIET) });
  const end = agentd({ 'PUT /observation/quiet': { status: 200, body: { quiet_until: null } }, 'GET /state': { status: 503, body: {} } });
  const e = new ObservationControl({ request: end.request, now: () => 0 });
  e.state.quietUntil = Date.parse(QUIET);
  await e.setQuiet(null);
  assert.deepEqual(end.calls[0], ['PUT', '/observation/quiet', { until: null }]);
  assert.equal(e.state.quietUntil, null, 'the reply ends it even when /state cannot be read');
});

test('setQuiet fails on an error status or a reply that is not an object, and leaves the state', async () => {
  for (const [reply, detail] of [[{ status: 409, body: { error: 'x' } }, 'HTTP 409'], [{ status: 200, body: '[1]' }, '后台的回包不是对象']] as const) {
    const a = agentd({ 'PUT /observation/quiet': reply });
    const o = new ObservationControl({ request: a.request, now: () => 0 });
    await assert.rejects(o.setQuiet(1), (e: unknown) => e instanceof BridgeFailure && e.code === 'failed' && e.detail === detail);
    assert.equal(o.state.quietUntil, null);
    assert.equal(a.calls.length, 1, 'no /state read after a failure');
  }
});

test('the settings page pauses, sets meeting and quiet, edits the blacklist and clears attention through agentd.request; the stack only meeting and quiet (protocol/ui-bridge/CONTRACT.md)', () => {
  const table = new RouteTable(routes);
  const main = [['PUT', '/observation/paused', { minutes: 60 }], ['PUT', '/observation/meeting', { on: true }], ['PUT', '/observation/quiet', { until: null }],
    ['GET', '/blacklist', null], ['POST', '/blacklist', { field: 'app_names', value: '微信' }], ['DELETE', '/blacklist', { field: 'domains', value: 'bank.example' }],
    ['POST', '/blacklist/defaults', null], ['DELETE', '/attention', null], ['GET', '/state', null]] as const;
  for (const [method, path, body] of main) assert.equal(checkRequest(table, 'main', method, path, body).ok, true, `${method} ${path}`);
  for (const [method, path, ok] of [['PUT', '/observation/meeting', true], ['PUT', '/observation/quiet', true], ['PUT', '/observation/paused', false],
    ['GET', '/blacklist', false]] as const) {
    assert.equal(checkRequest(table, 'stack', method, path, null).ok, ok, `stack ${method} ${path}`);
  }
});
