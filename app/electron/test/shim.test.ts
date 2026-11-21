import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { boot, handle, type Reply } from '../src/common/bridge.ts';
import { installBridge, type Push } from '../src/common/shim.ts';
import { ORIGIN } from '../src/common/ui.ts';

type Calls = Array<[string, unknown[]]>;
const g = globalThis as unknown as { window: Record<string, any> };

/** Installs the shim the way the preload does: from its source text, so it may use nothing from its module. */
function install(surface: 'main' | 'stack' = 'main', answer?: Reply): { calls: Calls; push: () => Push } {
  g.window = {};
  const calls: Calls = [];
  let push: Push | undefined;
  const fromSource = new Function('return (' + installBridge.toString() + ')')() as typeof installBridge;
  fromSource(boot(surface), async (op, args) => {
    calls.push([op, args]);
    return answer ?? handle(surface, { mainFrame: true, origin: ORIGIN }, { op, args });
  }, (p) => { push = p; });
  return { calls, push: () => push! };
}

beforeEach(() => { delete (g as { window?: unknown }).window; });

test('window.agenticComplex has the protocol.ts members, frozen', () => {
  install();
  const bridge = g.window.agenticComplex;
  assert.equal(bridge.surface, 'main');
  assert.equal(typeof bridge.capabilities.hotkeys, 'boolean');
  for (const op of boot('main').ops) {
    const parts = op.split('.');
    const fn = parts.reduce((node: any, p) => node[p], bridge);
    assert.equal(typeof fn, 'function', op);
  }
  assert.ok(Object.isFrozen(bridge) && Object.isFrozen(bridge.avatar.preview));
  assert.throws(() => { bridge.app = {}; });
});

test('an op the shell does not implement rejects with an Error with code and detail', async () => {
  const { calls } = install();
  await assert.rejects(g.window.agenticComplex.app.info(), (e: Error & { code?: string; detail?: string }) => {
    assert.equal(e.code, 'not_implemented');
    assert.equal(e.detail, 'app.info');
    assert.equal(e.message, 'not_implemented: app.info');
    assert.ok(e instanceof Error);
    return true;
  });
  await assert.rejects(g.window.agenticComplex.agentd.request('GET', '/health', undefined), { code: 'not_implemented' });
  assert.deepEqual(calls, [['app.info', []], ['agentd.request', ['GET', '/health', null]]]);
});

test('an op outside the surface goes to the main process and comes back op_not_allowed', async () => {
  install('stack');
  await assert.rejects(g.window.agenticComplex.settings.read(), { code: 'op_not_allowed', detail: 'settings.read' });
});

test('subscriptions and void window calls send through invoke and swallow the refusal', async () => {
  const { calls, push } = install();
  const seen: unknown[] = [];
  const unsubscribe = g.window.agenticComplex.avatar.onState((s: unknown) => seen.push(s));
  const unfeed = g.window.agenticComplex.feed.subscribe(() => {}, () => {}, '12');
  assert.equal(g.window.agenticComplex.window.close(), undefined);
  assert.equal(typeof unsubscribe, 'function');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.map(([op]) => op), ['avatar.onState', 'feed.subscribe', 'window.close']);
  assert.deepEqual(calls[1][1], [2, '12']);
  // The refused subscription is dropped, so a push for its id reaches nothing.
  push()(1, 'avatar.onState', 'event', { event: 'state', id: null, data: '{"running":true}' });
  assert.deepEqual(seen, []);
  unsubscribe();
  unfeed();
  assert.equal(calls.length, 3);
});

test('a push reaches an accepted subscription until it unsubscribes', async () => {
  const { calls, push } = install('main', { ok: true, value: null });
  const seen: unknown[] = [];
  const unsubscribe = g.window.agenticComplex.avatar.onState((s: unknown) => seen.push(s));
  await new Promise((r) => setTimeout(r, 0));
  push()(1, 'avatar.onState', 'event', { event: 'state', id: null, data: '{"running":true}' });
  push()(1, 'feed', 'event', { event: 'x', id: null, data: '{}' });
  assert.deepEqual(seen, [{ running: true }]);
  unsubscribe();
  assert.deepEqual(calls.at(-1), ['events.unsubscribe', [1]]);
  push()(1, 'avatar.onState', 'event', { event: 'state', id: null, data: '{"running":false}' });
  assert.equal(seen.length, 1);
});
