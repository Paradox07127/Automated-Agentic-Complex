// The capture plug-ins' system grants (ops/permissions.ts `askForPluginGrants`): turning 屏幕识读, 屏幕感知 or 电脑操作 on,
// or launching with one on, has the platform helper ask once for each grant they need and lack, so that macOS shows its
// prompt and lists the app. A fake helper and a temporary config.json; nothing asks the real system.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle, type Reply } from '../src/common/bridge.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { HelperReply } from '../src/main/helper/client.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { askForPluginGrants } from '../src/main/ops/permissions.ts';

const ok = (result: Record<string, unknown>): HelperReply => ({ ok: true, result });

/** Reads `states` and answers each request with the kind's state there. */
class FakeHelper {
  readonly requests: [string, Record<string, unknown>][] = [];
  private readonly states: Record<string, string>;
  constructor(states: Record<string, string>) {
    this.states = states;
  }
  async request(op: string, params: Record<string, unknown> = {}): Promise<HelperReply> {
    this.requests.push([op, params]);
    if (op === 'permissions.status') return ok(this.states);
    if (op === 'permissions.request') return ok({ state: this.states[params.kind as string] });
    return { ok: false, error: { code: 'unsupported', message: op } };
  }
}

const NONE = { accessibility: 'denied', screenRecording: 'denied', microphone: 'granted', automation: 'granted',
  inputMonitoring: 'granted', notifications: 'granted' };

function setup(helper: FakeHelper, platform: 'mac' | 'windows' = 'mac') {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-grants-'));
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: null, devResources: null },
    agentd: null, store: null, diag: null, supervisor: null, library: null,
    confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0.0.0', os: 'test' },
    loginItem: { enabled: () => false, set: () => {} },
    settingsChanges: silentSource,
    log: () => {},
    helper,
    platform,
  };
  const ops = registry(ctx), page = new PageSession(() => {});
  const call = async (op: string, args: unknown[] = []) => {
    const r = (await handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page)) as Reply;
    assert.ok(r.ok, JSON.stringify(r));
    // The save does not wait for the helper's asks.
    await new Promise((resolve) => setImmediate(resolve));
    return r.value;
  };
  return { ctx, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('turning 屏幕识读 on without the grant asks the helper for screen recording once; the grant then reads denied', async () => {
  const helper = new FakeHelper(NONE);
  const { call, done } = setup(helper);
  try {
    await call('settings.save', [{ 'plugins.screen_reading': true }]);
    assert.deepEqual(helper.requests, [['permissions.status', {}], ['permissions.request', { kind: 'screenRecording' }]]);
    // Asked and still missing: a refusal, which only System Settings can undo.
    assert.equal((await call('permissions.status') as Record<string, string>).screenRecording, 'denied');
  } finally {
    done();
  }
});

test('a grant already given, turning a plug-in off, or another key asks for nothing', async () => {
  const granted = new FakeHelper({ ...NONE, screenRecording: 'granted' });
  const a = setup(granted);
  try {
    await a.call('settings.save', [{ 'plugins.screen_reading': true }]);
    assert.deepEqual(granted.requests, [['permissions.status', {}]]);
  } finally {
    a.done();
  }
  const helper = new FakeHelper(NONE);
  const b = setup(helper);
  try {
    await b.call('settings.save', [{ 'plugins.screen_reading': false, mute: true }]);
    await b.call('settings.save', [{ 'plugins.light_ai': false }]);
    assert.deepEqual(helper.requests, []);
  } finally {
    b.done();
  }
});

test('屏幕感知 and 电脑操作 at launch ask for accessibility and screen recording, each once', async () => {
  const helper = new FakeHelper(NONE);
  const { ctx, done } = setup(helper);
  try {
    await askForPluginGrants(ctx, ['light_ai', 'screen_awareness', 'computer_use']);
    assert.deepEqual(helper.requests, [['permissions.status', {}], ['permissions.request', { kind: 'accessibility' }],
      ['permissions.request', { kind: 'screenRecording' }]]);
  } finally {
    done();
  }
});

test('Windows has no grant to ask for: the helper is not asked', async () => {
  const helper = new FakeHelper(NONE);
  const { ctx, call, done } = setup(helper, 'windows');
  try {
    await call('settings.save', [{ 'plugins.screen_reading': true }]);
    await askForPluginGrants(ctx, ['screen_awareness', 'screen_reading', 'computer_use']);
    assert.deepEqual(helper.requests, []);
  } finally {
    done();
  }
});
