import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import ops from '../../../protocol/ui-bridge/ops.json' with { type: 'json' };
import onboarding from '../../../protocol/ui-bridge/onboarding-ops.json' with { type: 'json' };
import { boot, BridgeFailure, handle, type Handler, type Surface } from '../src/common/bridge.ts';
import { ORIGIN } from '../src/common/ui.ts';

const RETURNS = new URL('../../../protocol/ui-bridge/returns/', import.meta.url);
const SURFACES: Surface[] = ['main', 'stack', 'onboarding'];
const page = { mainFrame: true, origin: ORIGIN };

interface ReturnCase { op: string; surface: Surface; args?: unknown[]; value?: unknown }
const cases: ReturnCase[] = readdirSync(RETURNS).filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(new URL(f, RETURNS), 'utf8')) as ReturnCase[]);

/** The `BridgeError` objects (`{code, detail?}`) inside the fixtures' resolved values. */
function fixtureErrors(): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'error' && x && typeof x === 'object' && 'code' in x) found.push(x as Record<string, unknown>);
        walk(x);
      }
    }
  };
  cases.forEach((c) => walk(c.value));
  return found;
}

test('every op a surface may send is accepted there and answered not_implemented', () => {
  for (const surface of SURFACES) {
    for (const op of ops.surfaces[surface]) {
      assert.deepEqual(handle(surface, page, { op, args: [] }), { ok: false, error: { code: 'not_implemented', detail: op } }, `${surface} ${op}`);
    }
  }
});

test('an op outside the surface, or outside ops.json, is op_not_allowed', () => {
  assert.deepEqual(handle('main', page, { op: 'stack.decide', args: [] }), { ok: false, error: { code: 'op_not_allowed', detail: 'stack.decide' } });
  assert.deepEqual(handle('stack', page, { op: 'settings.save', args: [] }), { ok: false, error: { code: 'op_not_allowed', detail: 'settings.save' } });
  assert.deepEqual(handle('onboarding', page, { op: 'app.info', args: [] }), { ok: false, error: { code: 'op_not_allowed', detail: 'app.info' } });
  for (const op of ['app.nope', 'constructor', '__proto__', '', 'app.info ']) {
    assert.deepEqual(handle('main', page, { op, args: [] }), { ok: false, error: { code: 'op_not_allowed', detail: op } }, JSON.stringify(op));
  }
});

test("a handler's failure is reported with the op and its code only, never the arguments or the detail; a success is not", async () => {
  const reported: [string, string][] = [];
  const handlers = new Map<string, Handler>([
    ['avatar.playAction', () => { throw new BridgeFailure('busy', '角色正在做别的动作'); }],
    ['app.info', () => { throw new Error('boom /Users/someone/secret'); }],
    ['avatar.stopAction', () => null],
  ]);
  const report = (op: string, code: string) => reported.push([op, code]);
  assert.deepEqual(await handle('main', page, { op: 'avatar.playAction', args: ['A_actor_wave', 1] }, handlers, undefined, report),
    { ok: false, error: { code: 'busy', detail: '角色正在做别的动作' } });
  assert.equal((await handle('main', page, { op: 'app.info', args: [] }, handlers, undefined, report)).ok, false);
  assert.equal((await handle('main', page, { op: 'avatar.stopAction', args: [] }, handlers, undefined, report)).ok, true);
  assert.deepEqual(reported, [['avatar.playAction', 'busy'], ['app.info', 'failed']]);
});

test('malformed messages, subframes and foreign origins are refused before the op name', () => {
  for (const message of [null, 'app.info', { args: [] }, { op: 7 }, { op: 'app.info', args: 'x' }]) {
    assert.deepEqual(handle('main', page, message), { ok: false, error: { code: 'invalid_args', detail: 'expected {op, args}' } }, JSON.stringify(message));
  }
  assert.deepEqual(handle('main', { mainFrame: false, origin: ORIGIN }, { op: 'app.info', args: [] }),
    { ok: false, error: { code: 'forbidden_frame', detail: 'not the main frame' } });
  assert.deepEqual(handle('main', { mainFrame: true, origin: 'https://example.com' }, { op: 'app.info', args: [] }),
    { ok: false, error: { code: 'forbidden_origin', detail: 'https://example.com' } });
});

test('boot lists every bridge member and the surface capabilities with host bits off, helper bits on while no op list is known', () => {
  const b = boot('main');
  assert.deepEqual(b.ops, [...ops.ops, ...onboarding.ops]);
  assert.equal(b.surface, 'main');
  assert.deepEqual(b.kinds, ops.kinds);
  for (const surface of SURFACES) {
    const bits = boot(surface).capabilities;
    assert.deepEqual(Object.keys(bits), Object.keys(ops.capabilities[surface]));
    for (const [name, v] of Object.entries(ops.capabilities[surface])) assert.equal(bits[name], v === true || v === 'host:helper', `${surface} ${name}`);
  }
  assert.equal(b.platform, 'mac');
});

test('boot turns actionLoop on when the avatar lists action_loop, and while its list is not known yet', () => {
  assert.equal(boot('main', 'mac', null, ['actions', 'action_loop']).capabilities.actionLoop, true);
  assert.equal(boot('main', 'mac', null, ['actions']).capabilities.actionLoop, false);
  assert.equal(boot('main', 'mac', null, null).capabilities.actionLoop, true);
  assert.equal(boot('stack', 'mac', null, ['action_loop']).capabilities.actionLoop, false);
});

const HELPER_BITS = ['helperPushToTalk', 'helperWindowText', 'helperTypedText', 'helperActionTimeline', 'helperSelectedText'];

test('boot turns a helper bit off when the helper\'s hello.ops lacks one of its ops', () => {
  const all = ['ptt.register', 'mic.start', 'ax.window_text', 'ax.watch', 'input.actions', 'ax.window_tree', 'ax.selected_text'];
  for (const surface of SURFACES) {
    const full = boot(surface, 'windows', all).capabilities;
    for (const name of HELPER_BITS) assert.equal(full[name], true, `${surface} ${name}`);
    const bits = boot(surface, 'windows', all.filter((op) => op !== 'ax.window_text' && op !== 'mic.start')).capabilities;
    assert.deepEqual(HELPER_BITS.filter((name) => !bits[name]), ['helperPushToTalk', 'helperWindowText'], surface);
    const none = boot(surface, 'windows', []).capabilities;
    assert.deepEqual(HELPER_BITS.filter((name) => none[name]), [], surface);
  }
});

test('boot on Windows names the platform and has no run-in-terminal; every other bit is the table\'s', () => {
  for (const surface of SURFACES) {
    const b = boot(surface, 'windows');
    assert.equal(b.platform, 'windows');
    assert.deepEqual(b.capabilities, { ...boot(surface).capabilities, runInTerminal: false }, surface);
  }
});

test('the not_implemented reply has the BridgeError shape the returns/ fixtures use, for every fixture op', async () => {
  const errors = fixtureErrors();
  assert.ok(errors.length > 0);
  const keys = new Set(['code', 'detail']);
  for (const e of errors) {
    for (const [k, v] of Object.entries(e)) {
      assert.ok(keys.has(k), `fixture error key ${k}`);
      assert.equal(typeof v, 'string');
    }
  }
  assert.ok(cases.length > 50);
  for (const c of cases) {
    const reply = await handle(c.surface, page, { op: c.op, args: c.args ?? [] });
    assert.equal(reply.ok, false);
    if (reply.ok) continue;
    assert.deepEqual(Object.keys(reply.error).sort(), ['code', 'detail'], c.op);
    assert.deepEqual(reply.error, { code: 'not_implemented', detail: c.op });
  }
});
