// agentd's `/feed` `command` events carried out (src/main/commands/feed.ts), against a fake
// helper and fake shell that record what they were asked: only an installed app the helper lists is opened, only a
// session or a running app is brought to the front, and nothing is opened or activated for real.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { feedCommand } from '../src/common/commands.ts';
import { silentSource } from '../src/common/feed.ts';
import type { AgentdClient } from '../src/main/agentd/client.ts';
import { feedCommands } from '../src/main/commands/feed.ts';
import type { HelperReply } from '../src/main/helper/client.ts';
import type { OpsContext } from '../src/main/ops/index.ts';

const ok = (result: Record<string, unknown>): HelperReply => ({ ok: true, result });
const err = (code: string): HelperReply => ({ ok: false, error: { code, message: code } });
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, done: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (done()) return true;
    await sleep(0.01);
  }
  return done();
}

const INSTALLED = ok({ apps: [{ path: '/Applications/Safari.app', name: 'Safari' }, { path: '/System/Applications/Notes.app', name: '备忘录' }] });
const RUNNING = ok({ apps: [{ app_id: 'com.apple.Safari', name: 'Safari', pid: 501, path: '/Applications/Safari.app', regular: true },
  { app_id: 'com.example.agent', name: 'Agent', pid: 777, path: '/Applications/Agent.app', regular: false }] });

function setup(f: { helper?: Record<string, HelperReply>; sessions?: unknown[]; sessionsStatus?: number; openPath?: string;
  openMain?: OpsContext['openMain'] } = {}) {
  const calls: string[] = [], notices: string[] = [], log: string[] = [];
  const table: Record<string, HelperReply> = { 'apps.installed': INSTALLED, 'apps.running': RUNNING, ...f.helper };
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: join(tmpdir(), 'feed-none', 'config.json'), supportDir: null, devResources: null },
    agentd: { request: async (method: string, path: string) => {
      calls.push(`agentd ${method} ${path}`);
      return { status: f.sessionsStatus ?? 200, body: Buffer.from(JSON.stringify({ sessions: f.sessions ?? [] })) };
    } } as unknown as AgentdClient,
    store: null, diag: null, supervisor: null, library: null,
    confirm: async (text) => { calls.push(`confirm ${text}`); return false; },
    shell: {
      openExternal: async (url) => { calls.push(`openExternal ${url}`); },
      openPath: async (path) => { calls.push(`openPath ${path}`); return f.openPath ?? ''; },
      showItemInFolder: (path) => { calls.push(`showItemInFolder ${path}`); },
    },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0.0.0', os: 'test' },
    loginItem: { enabled: () => false, set: () => {} },
    settingsChanges: silentSource,
    log: () => {},
    helper: { request: async (op, params = {}) => {
      calls.push(`helper ${op} ${JSON.stringify(params)}`);
      return table[op] ?? err('unsupported');
    } },
    platform: 'mac',
    commands: { executable: () => null, run: async (file) => { calls.push(`run ${file}`); return { ok: false, message: 'no' }; } },
    openMain: f.openMain,
  };
  const feed = feedCommands({ ctx, notice: (text) => notices.push(text), log: (line) => log.push(line) });
  let seq = 0;
  const command = (action: string, target: string) => feed({ event: 'command', id: String(++seq), data: JSON.stringify({ seq, action, target }) });
  return { calls, notices, log, feed, command };
}

test('a feed `command` event reads as a FeedCommand; anything else is not one', () => {
  assert.deepEqual(feedCommand({ event: 'command', data: '{"seq":3,"action":"open","target":"Safari","extra":1}' }),
    { seq: 3, action: 'open', target: 'Safari' });
  assert.deepEqual(feedCommand({ event: 'command', data: '{"seq":3,"action":"dance","target":""}' }), { seq: 3, action: 'dance', target: '' });
  for (const data of ['{"seq":3,"action":"open"}', '{"seq":"3","action":"open","target":"x"}', '{"seq":3.5,"action":"open","target":"x"}',
    '{"seq":3,"action":1,"target":"x"}', '[]', 'null', 'not json']) {
    assert.equal(feedCommand({ event: 'command', data }), null, data);
  }
  assert.equal(feedCommand({ event: 'line', data: '{"seq":3,"action":"open","target":"Safari"}' }), null);
});

test('open: an installed app the helper lists opens by file or display name; no notice', async () => {
  const s = setup();
  s.command('open', 'safari');
  s.command('open', '备忘录');
  assert.ok(await until(1, () => s.log.length === 2));
  assert.deepEqual(s.calls.filter((c) => c.startsWith('openPath')), ['openPath /Applications/Safari.app', 'openPath /System/Applications/Notes.app']);
  assert.deepEqual(s.log, ['FEED command action=open result=opened', 'FEED command action=open result=opened']);
  assert.deepEqual(s.notices, []);
});

test('open: anything but an installed app is not found and opens nothing, a URL or a path included', async () => {
  const s = setup();
  for (const target of ['Xcode', 'https://example.com/x.app', '/etc/passwd', '/Applications/Safari.app/../../etc', 'file:///tmp/a.app', '']) {
    s.command('open', target);
  }
  assert.ok(await until(1, () => s.log.length === 6));
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('helper apps.installed')), []);
  assert.deepEqual(s.notices, ['没找到应用「Xcode」', '没找到应用「https://example.com/x.app」', '没找到应用「/etc/passwd」',
    '没找到应用「/Applications/Safari.app/../../etc」', '没找到应用「file:///tmp/a.app」', '没找到应用「」']);
  assert.ok(s.log.every((l) => l === 'FEED command action=open result=not_found'));
});

test('open: an app the system cannot open is a notice', async () => {
  const s = setup({ openPath: 'LSOpen failed' });
  s.command('open', 'Safari');
  assert.ok(await until(1, () => s.log.length === 1));
  assert.deepEqual(s.notices, ['打不开「Safari」']);
  assert.deepEqual(s.log, ['FEED command action=open result=open_failed']);
});

test('jump: a matching session jumps without a notice, its failure only logged; else a running regular app is activated', async () => {
  const session = { session_id: 's1', own: false, target: 'claude', cwd: '/Users/me/endfield', updated_at: 5, title: null, state: 'idle',
    origin: { kind: 'terminal', bundle_id: 'com.example.term' } };
  const jumped = setup({ sessions: [session], helper: { 'apps.activate': ok({ activated: true }) } });
  jumped.command('jump', 'Endfield');
  assert.ok(await until(1, () => jumped.log.length === 1));
  assert.deepEqual(jumped.log, ['FEED command action=jump result=session_jump note=已跳转']);
  assert.ok(jumped.calls.includes('helper apps.activate {"app_id":"com.example.term"}'));
  const gone = setup({ sessions: [session], helper: { 'apps.activate': err('process_gone') } });
  gone.command('jump', 'endfield');
  assert.ok(await until(1, () => gone.log.length === 1));
  assert.deepEqual(gone.log, ['FEED command action=jump result=session_jump note=com.example.term 没在运行']);
  assert.deepEqual(gone.notices, []);
  const app = setup({ sessionsStatus: 503, helper: { 'apps.activate': ok({ activated: true }) } });
  app.command('jump', 'safari');
  assert.ok(await until(1, () => app.log.length === 1));
  assert.deepEqual(app.log, ['FEED command action=jump result=activated']);
  assert.ok(app.calls.includes('helper apps.running {"regular_only":true}'));
  assert.ok(app.calls.includes('helper apps.activate {"pid":501}'));
  assert.deepEqual(app.notices, []);
});

test('jump: her own session opens the sessions route through openMain without activating, logged as the panel\'s', async () => {
  const mine = { session_id: 'mine 1', own: true, target: 'claude', cwd: '/work/mine', updated_at: 5, title: null, state: 'idle', origin: null };
  const opened: [string, boolean | undefined][] = [];
  const s = setup({ sessions: [mine], openMain: (route, activate) => { opened.push([route, activate]); } });
  s.command('jump', 'mine');
  assert.ok(await until(1, () => s.log.length === 1));
  assert.deepEqual(opened, [['/overview?sel=mine%201&focus=task-mine%201', false]]);
  assert.deepEqual(s.log, ['FEED command action=jump result=session_panel selected=mine 1']);
  assert.deepEqual(s.notices, []);
  assert.ok(!s.calls.some((c) => c.startsWith('helper')));
  // Without a main window to open: no jump plan, so the running apps.
  const none = setup({ sessions: [mine] });
  none.command('jump', 'mine');
  assert.ok(await until(1, () => none.log.length === 1));
  assert.deepEqual(none.notices, ['没找到「mine」']);
});

test('jump: nothing matching, or only an accessory app, is a notice', async () => {
  const s = setup();
  s.command('jump', 'Xcode');
  s.command('jump', 'Agent');
  assert.ok(await until(1, () => s.log.length === 2));
  assert.deepEqual(s.notices, ['没找到「Xcode」', '没找到「Agent」']);
  assert.ok(!s.calls.some((c) => c.startsWith('helper apps.activate') || c.startsWith('openPath') || c.startsWith('openExternal')));
});

test('another action, another event or a broken one does nothing; a helper that fails is logged', async () => {
  const s = setup();
  s.command('run', 'rm -rf /');
  s.command('openURL', 'https://example.com');
  s.feed({ event: 'line', id: '9', data: JSON.stringify({ seq: 9, action: 'open', target: 'Safari' }) });
  s.feed({ event: 'command', id: '10', data: '{"seq":10,"action":"open"}' });
  await sleep(0.1);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.log, []);
  assert.deepEqual(s.notices, []);
  const down = setup({ helper: { 'apps.installed': err('helper_exited') } });
  down.command('open', 'Safari');
  assert.ok(await until(1, () => down.log.length === 1));
  assert.deepEqual(down.log, ['FEED command action=open failed: 系统助手没能完成 apps.installed（helper_exited）']);
  assert.deepEqual(down.notices, []);
});
