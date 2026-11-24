// character.*, mmd.* and onboarding.* ops, over fakes of agentd and the tools.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle, type Surface } from '../src/common/bridge.ts';
import { toolFailure } from '../src/common/character.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { AgentdClient } from '../src/main/agentd/client.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import type { ToolResult } from '../src/main/ops/context.ts';
import type { AvatarHost } from '../src/main/ops/avatar.ts';

interface Fake {
  /** agentd's `GET /state` character; undefined: agentd does not answer. */
  character?: string | null;
  facts: { fact_id: string; kind: string; text: string; version: number }[];
  /** Status of agentd's memory writes. */
  writeStatus: number;
  sent: string[];
  tools: string[][];
  tool: (args: string[]) => ToolResult;
  picked: string | null;
  restarts: number;
  rosters: number;
  /** The host link; absent without a renderer. */
  avatar?: { -readonly [K in 'currentCharacter' | 'currentAppearance' | 'appearances' | 'layers' | 'hiddenLayers']: AvatarHost[K] };
  /** The character switch; absent without a renderer link. */
  switcher?: { busy: boolean; held: boolean; current: string | null; switchOutcome(): Promise<never> };
  /** `switcher.held` at each `GET /state`. */
  heldAtState: (boolean | undefined)[];
  /** Calls of `supervisor.restartAvatar`. */
  avatarRestarts: number;
}

function setUp(dir: string, fake: Fake, surface: Surface = 'main') {
  const agentd = {
    request: async (method: string, path: string, json?: unknown) => {
      if (path === '/state') fake.heldAtState.push(fake.switcher?.held);
      if (fake.character === undefined) throw new Error('offline');
      fake.sent.push(`${method} ${path}${json === undefined ? '' : ` ${JSON.stringify(json)}`}`);
      const reply = (status: number, body: unknown) => ({ status, body: Buffer.from(JSON.stringify(body)) });
      if (path === '/state') return reply(200, { character: fake.character });
      if (path === '/memory') return reply(200, { facts: fake.facts });
      if (path === '/diag/state') return reply(200, { hooks: { codex: { installed: false } } });
      return reply(fake.writeStatus, {});
    },
  } as unknown as AgentdClient;
  const ctx: OpsContext = {
    surface, routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd, store: null, diag: null,
    avatar: fake.avatar as AvatarHost | undefined, switcher: fake.switcher,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => { fake.restarts += 1; }, avatar: () => ({ kind: 'stopped' }),
      restartAvatar: () => { fake.avatarRestarts += 1; } },
    library: {
      catalog: join(dir, 'library', 'current.json'), launched: 'si', characterName: 'Si', hookCommand: "'py' hooks.py",
      validationHost: () => '/host', runTool: async (script, args) => { fake.tools.push([script, ...args]); return fake.tool(args); },
      rosterChanged: () => { fake.rosters += 1; },
    },
    confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => fake.picked, saveFile: async () => false },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
  };
  const ops = registry(ctx), page = new PageSession(() => {});
  return (op: string, ...args: unknown[]) => handle(surface, { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
}

function withDir(body: (dir: string, fake: Fake) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'character-'));
    mkdirSync(join(dir, 'library', 'si'), { recursive: true });
    mkdirSync(join(dir, 'library', 'cedar'), { recursive: true });
    writeFileSync(join(dir, 'library', 'current.json'), JSON.stringify({ schema: 'endfield-character-library/v1',
      characters: [{ id: 'si', definition: { file: 'si/character.json' } }, { id: 'cedar', definition: { file: 'cedar/character.json' } }] }));
    writeFileSync(join(dir, 'library', 'si', 'character.json'), JSON.stringify({ id: 'si', display: { name: { 'zh-Hans': '斯', en: 'Si' } },
      components: { voice: { character: 'si', language: 'zh' } } }));
    writeFileSync(join(dir, 'library', 'cedar', 'character.json'), JSON.stringify({ id: 'cedar', display: { name: { 'zh-Hans': '陈' } } }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ python: '/usr/bin/python3', motion_playlists: { cedar: { items: ['a'], loop: 'one', speed: 2 } } }));
    const fake: Fake = { character: 'si', facts: [], writeStatus: 200, sent: [], tools: [], picked: null, restarts: 0, rosters: 0,
      heldAtState: [], avatarRestarts: 0, tool: () => ({ last: '{}', status: 0, stderr: '' }) };
    try {
      await body(dir, fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('character.list reads the library, marks agentd\'s character and says which has a voice; an empty library lists none', withDir(async (dir, fake) => {
  const call = setUp(dir, fake);
  assert.deepEqual(await call('character.list'), { ok: true, value: [
    { id: 'si', name: '斯', en: 'Si', active: true, appearances: [], voice: true },
    { id: 'cedar', name: '陈', en: '', active: false, appearances: [], voice: false },
  ] });
  fake.character = undefined;
  assert.equal(((await call('character.list')) as { value: { active: boolean }[] }).value[0]!.active, false, 'no switch: none is current');
  writeFileSync(join(dir, 'library', 'current.json'), JSON.stringify({ schema: 'endfield-character-library/v1', characters: [] }));
  assert.deepEqual(await call('character.list'), { ok: true, value: [] });
}));

test('while agentd does not answer the motion ops, the playlist and the list take the switch\'s character, held before it is read', withDir(async (dir, fake) => {
  // Launched as si (`library.launched`), switched to cedar.
  fake.switcher = { busy: false, held: false, current: 'cedar', switchOutcome: async (): Promise<never> => { throw new Error('unused'); } };
  fake.character = undefined;
  const call = setUp(dir, fake);
  assert.deepEqual(await call('character.removeMotion', 'm'), { ok: true, value: { ok: true, id: 'm' } });
  const args = fake.tools.at(-1)!;
  assert.equal(args[args.indexOf('--character') + 1], 'cedar');
  assert.deepEqual(fake.heldAtState, [true], 'the switch is held when the character is read');
  assert.equal(fake.switcher.held, false);
  assert.deepEqual(await call('character.getPlaylist'), { ok: true, value: { items: ['a'], loop: 'one', speed: 2 } });
  assert.deepEqual(((await call('character.list')) as { value: { id: string; active: boolean }[] }).value.map((c) => [c.id, c.active]),
    [['si', false], ['cedar', true]]);
  fake.switcher.current = null;
  assert.deepEqual(await call('character.listImportedMotions'), { ok: true, value: { ok: false, reason: 'internal', detail: '角色还没连上' } });
}));

test('character.list gives the current character the appearances and the worn appearance\'s layers the renderer reported', withDir(async (dir, fake) => {
  fake.avatar = { currentCharacter: 'si', currentAppearance: 'summer',
    appearances: [{ id: 'default', name: '默认', kind: 'outfit', desc: '常服' }, { id: 'summer', name: '夏装' }],
    layers: [{ id: 'coat', name: '外套', appearances: ['summer'] }, { id: 'hat', name: '帽子', appearances: ['default'] }, { id: 'bag', name: '包' }],
    hiddenLayers: ['bag'] };
  const call = setUp(dir, fake);
  assert.deepEqual(await call('character.list'), { ok: true, value: [
    { id: 'si', name: '斯', en: 'Si', active: true, voice: true,
      appearances: [{ id: 'default', name: '默认', desc: '常服', kind: 'outfit' }, { id: 'summer', name: '夏装', desc: '' }],
      layers: [{ id: 'coat', name: '外套', visible: true }, { id: 'bag', name: '包', visible: false }] },
    { id: 'cedar', name: '陈', en: '', active: false, appearances: [], voice: false },
  ] });
  // While the renderer still shows another character its lists are not this one's.
  fake.avatar.currentCharacter = 'cedar';
  assert.deepEqual(((await call('character.list')) as { value: Record<string, unknown>[] }).value[0],
    { id: 'si', name: '斯', en: 'Si', active: true, appearances: [], voice: true });
}));

test('character.list gives an imported appearance the warnings of its import report in the package; an unreadable report fails the list', withDir(async (dir, fake) => {
  fake.avatar = { currentCharacter: 'si', currentAppearance: 'default',
    appearances: [{ id: 'default', name: '默认', kind: 'original' }, { id: 'mod_1a2b3c4d', name: '示例外观', kind: 'imported', desc: '导入的外观' }],
    layers: [], hiddenLayers: [] };
  mkdirSync(join(dir, 'library', 'si', 'provenance'));
  writeFileSync(join(dir, 'library', 'si', 'provenance', 'outfit-mod_1a2b3c4d.json'),
    JSON.stringify({ schema: 'endfield-outfit-import/v1', appearance: { id: 'mod_1a2b3c4d' }, warnings: ['texture_unbound:Tex/14.dds', 'setting_fixed:glow'] }));
  const call = setUp(dir, fake);
  assert.deepEqual(((await call('character.list')) as { value: { appearances: unknown[] }[] }).value[0]!.appearances, [
    { id: 'default', name: '默认', desc: '', kind: 'original' },
    { id: 'mod_1a2b3c4d', name: '示例外观', desc: '导入的外观', kind: 'imported', warnings: ['texture_unbound:Tex/14.dds', 'setting_fixed:glow'] },
  ]);
  rmSync(join(dir, 'library', 'si', 'provenance', 'outfit-mod_1a2b3c4d.json'));
  const reply = await call('character.list') as { ok: boolean; error?: { code: string } };
  assert.equal(reply.ok, false);
  assert.equal(reply.error?.code, 'failed');
}));

test('a package imported into a library agentd runs without a character restarts agentd and the renderer', withDir(async (dir, fake) => {
  const call = setUp(dir, fake);
  assert.deepEqual(await call('character.importPackage'), { ok: true, value: { ok: false, reason: 'cancelled' } });
  fake.picked = '/pkg/si.endfield-character';
  fake.character = null;
  assert.deepEqual(await call('character.importPackage'), { ok: true, value: { ok: true } });
  assert.deepEqual(fake.tools.at(-1), ['character_tool.py', 'install', '/pkg/si.endfield-character', '--library', join(dir, 'library'),
    '--validate-with', '/host']);
  assert.equal(fake.restarts, 1);
  assert.equal(fake.avatarRestarts, 1, 'the renderer starts again too, on the new roster (restartChildren)');
  fake.character = 'si';
  assert.deepEqual(await call('character.importPackage'), { ok: true, value: { ok: true } });
  assert.equal(fake.restarts, 1, 'agentd has a character');
  assert.equal(fake.avatarRestarts, 1);
  assert.equal(fake.rosters, 2, 'each import that succeeded refreshes the roster the renderer launches from');
  fake.tool = () => ({ last: '', status: 2, stderr: 'bad package' });
  assert.deepEqual(await call('character.importPackage'), { ok: true, value: { ok: false, reason: '角色包导入失败：bad package' } });
  assert.equal(fake.rosters, 2);
}));

test('motion ops check ids and titles, run motion_tool on the current character and pass on its failures', withDir(async (dir, fake) => {
  const call = setUp(dir, fake);
  const bad = { ok: false, error: { code: 'bad_args', detail: 'character.renameMotion' } };
  assert.deepEqual(await call('character.renameMotion', 'm', '   '), bad);
  assert.deepEqual(await call('character.renameMotion', 'x'.repeat(65), 'ok'), bad);
  assert.deepEqual(await call('character.renameMotion', 'm', '字'.repeat(65)), bad);
  assert.deepEqual(await call('character.removeMotion', ''), { ok: false, error: { code: 'bad_args', detail: 'character.removeMotion' } });
  fake.tool = (args) => ({ last: JSON.stringify({ id: 'm', title: args.find((a) => a.startsWith('--title='))?.slice(8) }), status: 0, stderr: '' });
  assert.deepEqual(await call('character.renameMotion', 'm', '  慢舞 '), { ok: true, value: { ok: true, id: 'm', title: '慢舞' } });
  assert.deepEqual(fake.tools.at(-1), ['motion_tool.py', 'rename', '--library', join(dir, 'library'), '--character', 'si', '--action', 'm',
    '--title=慢舞', '--validate-with', '/host']);
  // A title starting with "-" stays the value of --title for argparse.
  assert.deepEqual(await call('character.renameMotion', 'm', '-intro'), { ok: true, value: { ok: true, id: 'm', title: '-intro' } });
  assert.ok(fake.tools.at(-1)!.includes('--title=-intro'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ action_switches: { si: { m: true, n: false } } }));
  assert.deepEqual(await call('character.removeMotion', 'm'), { ok: true, value: { ok: true, id: 'm' } });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')), { action_switches: { si: { n: false } } });
  fake.tool = () => ({ last: '', status: 1, stderr: '{"reason": "unknown_action", "detail": "m"}\n' });
  assert.deepEqual(await call('character.removeMotion', 'm'), { ok: true, value: { ok: false, reason: 'unknown_action', detail: 'm' } });
  fake.character = null;
  assert.deepEqual(await call('character.listImportedMotions'), { ok: true, value: { ok: false, reason: 'internal', detail: '角色还没连上' } });
  assert.deepEqual(toolFailure('Traceback\n{"reason": "nope"}\n'), { reason: 'internal', detail: 'Traceback\n{"reason": "nope"}' });
}));

test('the playlist is config.json motion_playlists of the current character', withDir(async (dir, fake) => {
  const call = setUp(dir, fake);
  assert.deepEqual(await call('character.getPlaylist'), { ok: true, value: { items: [], loop: 'off', speed: 1 } });
  const invalid = { ok: false, error: { code: 'invalid_args', detail: '{items, loop: off|one|all, speed: 0.5|1|2}' } };
  assert.deepEqual(await call('character.setPlaylist', { items: [], loop: 'all', speed: 3 }), invalid);
  assert.deepEqual(await call('character.setPlaylist', { items: Array(129).fill('a'), loop: 'all', speed: 1 }), invalid);
  assert.deepEqual(await call('character.setPlaylist', { items: [''], loop: 'all', speed: 1 }),
    { ok: false, error: { code: 'invalid_args', detail: 'items: action ids of 1-64 bytes' } });
  assert.deepEqual(await call('character.setPlaylist', { items: ['b', 'c'], loop: 'all', speed: 0.5 }), { ok: true, value: { ok: true } });
  assert.deepEqual(await call('character.getPlaylist'), { ok: true, value: { items: ['b', 'c'], loop: 'all', speed: 0.5 } });
  const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(file.motion_playlists, { cedar: { items: ['a'], loop: 'one', speed: 2 }, si: { items: ['b', 'c'], loop: 'all', speed: 0.5 } });
  assert.equal(file.python, '/usr/bin/python3');
  fake.character = null;
  assert.deepEqual(await call('character.getPlaylist'), { ok: false, error: { code: 'failed', detail: '角色还没连上' } });
}));

test('import and MMD sync states are idle and their watches subscribe', withDir(async (dir, fake) => {
  const call = setUp(dir, fake);
  assert.deepEqual(await call('character.importState'),
    { ok: true, value: { running: false, kind: null, title: null, stage: null, fraction: 0 } });
  assert.deepEqual(await call('mmd.syncState'),
    { ok: true, value: { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 } });
  assert.deepEqual(await call('character.onImport', 1), { ok: true, value: null });
  assert.deepEqual(await call('mmd.onSync', 2), { ok: true, value: null });
  fake.tool = () => ({ last: '', status: 1, stderr: 'boom' });
  assert.deepEqual(await call('mmd.list'), { ok: true, value: { ok: false, reason: 'internal', detail: 'boom' } });
}));

test('onboarding walks its four steps without agentd; 完成 stores only onboarding_done, so a choice saved on the way stays', withDir(async (dir, fake) => {
  const call = setUp(dir, fake, 'onboarding');
  const state = async (op: string, ...args: unknown[]) => {
    const r = await call(op, ...args);
    if (!r.ok) return r.error;
    return r.value as Record<string, unknown>;
  };
  assert.deepEqual(await state('onboarding.state'), {
    steps: [{ id: 1, number: '01', title: '角色', result: 'todo' }, { id: 2, number: '02', title: '对话', result: 'todo' },
      { id: 3, number: '03', title: '声音', result: 'todo' }, { id: 4, number: '04', title: '完成', result: 'todo' }],
    step: 1, done: false, canAdvance: true, characterName: 'Si', completionError: null,
  });
  assert.deepEqual(await state('onboarding.back'), { code: 'invalid_state', detail: 'cannot go back' });
  assert.deepEqual(await state('onboarding.complete'), { code: 'invalid_state', detail: 'complete at the last step' });
  for (const step of [2, 3, 4]) assert.equal((await state('onboarding.advance') as Record<string, unknown>).step, step);
  assert.deepEqual(await state('onboarding.advance'), { code: 'invalid_state', detail: 'cannot advance this step' });
  for (const bad of ['pet', { companion: 'pet' }, { destination: 'privacy' }, { destination: 'home', extra: 1 }, ['home']]) {
    assert.deepEqual(await state('onboarding.complete', bad), { code: 'invalid_args', detail: 'onboarding destination' }, JSON.stringify(bad));
  }
  const end = await state('onboarding.complete') as Record<string, unknown>;
  assert.equal(end.done, true);
  assert.equal(end.completionError, null);
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.onboarding_done, true);
  assert.equal(config.plugins, undefined, 'the end writes no choice');
  assert.equal(fake.restarts, 0, 'nothing changed that agentd takes at start');
  assert.deepEqual(fake.sent, [], 'the guide asks agentd for nothing');
  assert.deepEqual(await state('onboarding.complete'), { code: 'invalid_state', detail: 'complete at the last step' });
}));
