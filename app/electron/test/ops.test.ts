import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import { type EventFeed, FeedSource, silentSource } from '../src/common/feed.ts';
import { type Cancel, PageSession, type StreamEvent } from '../src/common/page.ts';
import { checkRequest, isExportPath, RouteTable, swapHandles } from '../src/common/routes.ts';
import { current, desktopHotkeys, hotkeyName, parseChanges, planSave, schema, snapshot, webHotkey } from '../src/common/settings.ts';
import type { HandedItem } from '../src/common/stack-cards.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { DropHandover } from '../src/main/handover/drop.ts';
import { avatarDetails, type AvatarHost } from '../src/main/ops/avatar.ts';
import { reloadAvatar } from '../src/main/ops/holding.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { localPath } from '../src/main/platform/index.ts';

const page0 = { mainFrame: true, origin: ORIGIN };

/** An AgentStore stand-in the test drives. */
class FakeFeed implements EventFeed {
  events = new Set<(e: StreamEvent) => void>();
  reloads = new Set<() => void>();
  subscribe(onEvent: (e: StreamEvent) => void): Cancel {
    this.events.add(onEvent);
    return () => this.events.delete(onEvent);
  }
  onReload(onReload: () => void): Cancel {
    this.reloads.add(onReload);
    return () => this.reloads.delete(onReload);
  }
  send(e: StreamEvent): void {
    for (const h of [...this.events]) h(e);
    if (e.event === 'gap' || e.event === 'reset') for (const h of [...this.reloads]) h();
  }
}

const ev = (id: string | null, event = 'feed', data = '{}'): StreamEvent => ({ event, id, data });

test('feed replays buffered events after afterSeq, and asks a page that missed events to reload', () => {
  const feed = new FakeFeed(), source = new FeedSource(feed);
  feed.send(ev('e1-1'));
  feed.send(ev('e1-2'));
  feed.send(ev('e1-3'));
  const got: string[] = [];
  let reloads = 0;
  const cancel = source.subscribe('e1-1', (e) => got.push(e.id!), () => { reloads += 1; });
  assert.deepEqual(got, ['e1-2', 'e1-3']);
  feed.send(ev('e1-4'));
  assert.deepEqual(got, ['e1-2', 'e1-3', 'e1-4']);
  assert.equal(reloads, 0);
  cancel();
  feed.send(ev('e1-5'));
  assert.equal(got.length, 3);
  source.subscribe('e0-9', () => {}, () => { reloads += 1; });
  assert.equal(reloads, 1, 'another epoch');
  feed.send(ev(null, 'gap'));
  let late = 0;
  source.subscribe('e1-5', () => {}, () => { late += 1; });
  assert.equal(late, 1, 'at the gap');
  assert.equal(reloads, 2, 'the gap reloads the live subscriber');
});

test('a page session drops pushes of an ended document and cancels its subscriptions', () => {
  const pushed: unknown[] = [];
  const page = new PageSession((...a) => pushed.push(a));
  const feed = new FakeFeed(), source = new FeedSource(feed);
  page.subscribe(page.generation, 'feed', 1, source, null);
  feed.send(ev('e-1'));
  assert.deepEqual(pushed, [[1, 'feed', 'event', ev('e-1')]]);
  page.end();
  feed.send(ev('e-2'));
  assert.equal(pushed.length, 1);
  assert.equal(feed.events.size, 1, 'only the source buffer is left');
  page.subscribe(0, 'feed', 2, source, null);
  assert.equal(feed.events.size, 1, 'an old generation subscribes nothing');
  page.pushRoute('settings');
  page.onRoute(page.generation, 3);
  assert.deepEqual(pushed.at(-1), [3, 'route', 'event', { event: 'route', id: null, data: 'settings' }]);
});

test('agentd.request refuses before sending', () => {
  const table = new RouteTable(routes);
  const code = (method: unknown, path: unknown, body: unknown = null) => {
    const r = checkRequest(table, 'main', method, path, body);
    return r.ok ? 'ok' : r.reply.error.code;
  };
  assert.equal(code('GET', '/health'), 'ok');
  assert.equal(code('get', '/health'), 'invalid_method');
  assert.equal(code('GET', '/a/../health'), 'invalid_path');
  assert.equal(code('GET', '//health'), 'invalid_path');
  assert.equal(code('GET', '/nope'), 'unclassified_route');
  assert.equal(code('GET', '/feed'), 'route_class');
  assert.equal(code('GET', '/characters/si/motion-graph?x=1'), 'ok');
  assert.equal(code('GET', '/characters/SI/motion-graph'), 'unclassified_route');
  assert.equal(code('POST', '/sessions', [1]), 'invalid_body');
  assert.equal(checkRequest(table, 'stack', 'GET', '/health', null).ok, false);
  const picked = new Map([['h1', { purpose: 'session_cwd', path: '/work' }]]);
  assert.deepEqual(swapHandles('POST', '/sessions', { cwd: { handle: 'h1' } }, picked).body, { cwd: '/work' });
  assert.throws(() => swapHandles('POST', '/sessions', { cwd: '/work' }, picked));
  assert.deepEqual(swapHandles('PUT', '/character/runtime', { workspace_dir: { handle: 'h1' } }, picked).body,
    { workspace_dir: '/work' });
  assert.throws(() => swapHandles('PUT', '/character/runtime', { workspace_dir: '/work' }, picked));
  assert.throws(() => swapHandles('POST', '/say', { cwd: null }, picked));
});

test('agentd.request and an export check the path the client sends: one that URL parsing changes is refused', () => {
  const table = new RouteTable(routes);
  const code = (method: string, path: string, body: unknown = null) => {
    const r = checkRequest(table, 'main', method, path, body);
    return r.ok ? 'ok' : r.reply.error.code;
  };
  // `new URL` reads `%2e%2e` as `..` and `\` as `/`: these would reach PUT /character/runtime and PUT /behavior/switches.
  assert.equal(code('PUT', '/schedules/%2e%2e\\character\\runtime', { executable: '/tmp/evil' }), 'invalid_path');
  assert.equal(code('PUT', '/schedules/%2e%2e\\behavior\\switches', {}), 'invalid_path');
  assert.equal(code('PUT', '/schedules/%2E%2E%2Fcharacter%2Fruntime', {}), 'ok', 'an encoded slash stays in the segment');
  assert.equal(code('GET', '/trace/turns/.'), 'invalid_path');
  assert.equal(code('GET', '/trace/turns?since=2026-11-20T10%3A00%3A00%2B08%3A00&limit=200'), 'ok');
  assert.equal(code('DELETE', '/memory/facts/own:f%201%2F2?expected_version=3'), 'ok');
  assert.equal(code('GET', `/observation/sources?${new URLSearchParams({ kind: 'work_events', query: '会议 纪要' })}`), 'ok');
  assert.equal(isExportPath('/trace/turns/t-1?with_text=1'), true);
  assert.equal(isExportPath('/trace/turns/%2e%2e\\%2e%2e\\memory'), false, 'would GET /memory');
  assert.equal(isExportPath('/memory/export?owner=aster'), true);
  assert.equal(isExportPath('/memory/export?owner=shared'), true);
  assert.equal(isExportPath(`/memory/export?owner=${encodeURIComponent('own:a/b')}`), true);
  assert.equal(isExportPath('/memory/export?owner='), false);
  assert.equal(isExportPath('/memory/export?owner=a&scope=all'), false);
  assert.equal(isExportPath('/memory/export?owner=a/b'), false);
});

test('hot keys convert between the page caps and config.json names', () => {
  assert.equal(hotkeyName('⌃⌥H', false), 'control+option+h');
  assert.equal(hotkeyName('⌃Space', false), 'control+space');
  assert.equal(hotkeyName('F5', false), 'f5');
  assert.equal(hotkeyName('⇧A', false), null);
  assert.equal(hotkeyName('⌃⌃A', false), null);
  assert.equal(hotkeyName('右⌥', false), null);
  assert.equal(hotkeyName('右⌥', true), 'right_option');
  assert.equal(webHotkey('ctrl+alt+space'), '⌃⌥Space');
  assert.equal(webHotkey('control+nope'), null);
});

function context(dir: string): OpsContext {
  return {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null,
    store: null, diag: null, supervisor: null, library: null, confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => '/picked/file', pickFolder: async () => '/picked', pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
  };
}

test('settings.save writes the changed keys and refuses launch keys and bad values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ python: '/usr/bin/python3', render_camera_yaw: 15, hotkey_look: 'bogus+' }));
    const ops = registry(context(dir)), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    const read = await call('settings.read');
    assert.ok(read.ok);
    const snap = read.value as { saved: Record<string, unknown>; statuses: Record<string, string> };
    assert.equal(snap.saved['rnd.yaw'], 15);
    assert.equal(snap.saved.hk_look, '⌃⌥L');
    assert.match(snap.statuses.hk_look!, /bogus\+/);
    assert.deepEqual(await call('settings.save', { mute: true, 'rnd.yaw': 30 }),
      { ok: true, value: { restart: 'none', notApplied: [] } });
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(file.mute, true);
    assert.equal(file.render_camera_yaw, 30);
    assert.equal(file.python, '/usr/bin/python3');
    const refused = await call('settings.save', { python: '/x' });
    assert.ok(refused.ok);
    assert.match((refused.value as { error: string }).error, /启动参数/);
    const bad = await call('settings.save', { asr: 'nope' });
    assert.ok(bad.ok);
    assert.match((bad.value as { error: string }).error, /可选 auto（跟随系统）/);
    assert.deepEqual(await call('settings.save', { hk_quick: '⌃⌥H' }),
      { ok: true, value: { restart: 'none', notApplied: [], error: '⌃⌥H 已被「显示 / 隐藏角色」占用' } });
    assert.deepEqual(await call('settings.validateHotkey', 'hk_quick', '⌘K'), { ok: true, value: { ok: false, conflictWith: '命令面板' } });
    assert.deepEqual(await call('settings.validateHotkey', 'mute', '⌃A'), { ok: false, error: { code: 'unknown_setting', detail: 'mute' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings.validateHotkey on Windows finds a clash with the Windows defaults and refuses Ctrl+K', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const ops = registry({ ...context(dir), platform: 'windows' }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('settings.validateHotkey', 'hk_quick', '⌃⌥H'), { ok: true, value: { ok: false, conflictWith: '显示 / 隐藏角色' } });
    assert.deepEqual(await call('settings.validateHotkey', 'hk_quick', '⌃K'), { ok: true, value: { ok: false, conflictWith: '命令面板' } });
    assert.equal(planSave({}, null, { hotkey_quick_input: 'control+option+h' }, 'windows').error, 'Ctrl+Alt+H 已被「显示 / 隐藏角色」占用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save of the behavior switches puts them with her hover buttons as they are then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const got: unknown[] = [];
    let dock = true;
    const agentd = { request: async (method: string, path: string, json: unknown) => {
      got.push([method, path, json]);
      return { status: 200, body: Buffer.from('{}') };
    } } as unknown as OpsContext['agentd'];
    const ops = registry({ ...context(dir), agentd, dockOpen: () => dock }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('settings.save', { 'beh.stay': 'stay' }), { ok: true, value: { restart: 'none', notApplied: [] } });
    dock = false;
    assert.deepEqual(await call('settings.save', { 'beh.stay': 'roam' }), { ok: true, value: { restart: 'none', notApplied: [] } });
    const switches = { sit_window_top: true, hold_window_edge: true, fullscreen_give_way: true };
    assert.deepEqual(got, [['PUT', '/behavior/switches', { stay_in_place: true, ...switches, hold_free_walks: true }],
      ['PUT', '/behavior/switches', { stay_in_place: false, ...switches }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('services.save refuses an id or record that does not hold, with its code and field, and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'services-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ mute: true }));
    const saved: string[] = [];
    const ops = registry({ ...context(dir), services: { view: () => ({ mode: 'off', state: null, pid: null, detail: null }),
      start: async () => ({ ok: true, line: null }), stop: async () => ({ ok: true, line: null }), restart: async () => ({ ok: true, line: null }),
      saved: (id) => { saved.push(id); } } });
    const page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('services.save', 'voice', { mode: 'off' }), { ok: true, value: { ok: false, error: 'unknown_service' } });
    const ssh = { mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box' };
    const bad: [unknown, string][] = [
      [null, ''], ['ssh', ''], [{ ...ssh, mode: 'tunnel' }, 'mode'], [{ ...ssh, extra: 1 }, 'extra'], [{ ...ssh, url: 'not a url' }, 'url'],
      [{ ...ssh, url: 'http://gpu-box:9880' }, 'url'], [{ ...ssh, url: 'http://127.0.0.1/tts' }, 'url'], [{ ...ssh, ssh_host: '' }, 'ssh_host'],
      ...['-oProxyCommand=touch x', 'gpu box', 'gpu\tbox', 'gpu\u0000box'].map((h): [unknown, string] => [{ ...ssh, ssh_host: h }, 'ssh_host']),
      [{ mode: 'local', url: 'http://127.0.0.1:11434/v1' }, 'command'], [{ mode: 'local', url: 'http://127.0.0.1:11434/v1', command: [''] }, 'command'],
      [{ mode: 'local', url: 'http://127.0.0.1:11434/v1', command: 'ollama serve' }, 'command'], [{ ...ssh, cwd: 3 }, 'cwd'],
    ];
    for (const [record, field] of bad) {
      const reply = await call('services.save', 'tts', record);
      assert.ok(reply.ok, JSON.stringify(record));
      const value = reply.value as { ok: boolean; error: string; field: string; message: string };
      assert.deepEqual([value.ok, value.error, value.field], [false, 'invalid_record', field], JSON.stringify(record));
      assert.match(value.message, /^服务 tts /);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')), { mute: true });
    assert.deepEqual(saved, []);
    for (const op of ['services.start', 'services.stop', 'services.restart']) {
      assert.deepEqual(await call(op, 'voice'), { ok: true, value: { ok: false, error: 'unknown_service', line: null } }, op);
    }
    writeFileSync(join(dir, 'config.json'), 'not json');
    assert.deepEqual(await call('services.save', 'tts', ssh), { ok: true, value: { ok: false, error: 'config_unreadable' } });
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), 'not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('services.save writes the record whole, keeps the other keys and services, and restarts the service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'services-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ mute: true, voice_service: 'remote',
      services: { motion: { mode: 'url', url: 'http://gpu:48830' } } }));
    const saved: string[] = [];
    const ops = registry({ ...context(dir), services: { view: () => ({ mode: 'off', state: null, pid: null, detail: null }),
      start: async () => ({ ok: true, line: null }), stop: async () => ({ ok: true, line: null }), restart: async () => ({ ok: true, line: null }),
      saved: (id) => { saved.push(id); } } });
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, new PageSession(() => {}));
    const local = { mode: 'local', url: 'http://127.0.0.1:11434/v1', command: ['ollama', 'serve'] };
    assert.deepEqual(await call('services.save', 'llm', local), { ok: true, value: { ok: true } });
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(file, { mute: true, voice_service: 'remote', services: { motion: { mode: 'url', url: 'http://gpu:48830' },
      llm: { mode: 'local', url: 'http://127.0.0.1:11434/v1', ssh_host: '', start_script: '', command: ['ollama', 'serve'], cwd: '' } } });
    assert.deepEqual(saved, ['llm']);
    const read = await call('services.read');
    assert.ok(read.ok);
    const all = read.value as Record<string, Record<string, unknown>>;
    assert.deepEqual([Object.keys(all), all.motion!.url, all.llm!.command, all.tts!.mode], [['tts', 'motion', 'llm'], 'http://gpu:48830',
      ['ollama', 'serve'], 'off']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('录屏时隐藏角色 is on by default on macOS and off on Windows, where saving a change restarts the renderer', async () => {
  assert.equal(current({}, null, 'mac').values.hide_on_screen_capture, true);
  assert.equal(current({}, null, 'windows').values.hide_on_screen_capture, false);
  assert.equal(current({ hide_on_screen_capture: true }, null, 'windows').values.hide_on_screen_capture, true);
  assert.equal(schema('mac').find((r) => r.id === 'capHide')?.default, true);
  assert.equal(schema('windows').find((r) => r.id === 'capHide')?.default, false);
  assert.deepEqual(planSave({}, null, { hide_on_screen_capture: false }, 'mac'),
    { write: { hide_on_screen_capture: false }, effects: [], restart: 'none' });
  assert.deepEqual(planSave({}, null, { hide_on_screen_capture: false }, 'windows'), { write: {}, effects: [], restart: 'none' });
  assert.deepEqual(planSave({}, null, { hide_on_screen_capture: true }, 'windows'),
    { write: { hide_on_screen_capture: true }, effects: [{ kind: 'restartAvatar' }], restart: 'avatar' });
  // With a backend restart in the same save the renderer still restarts.
  assert.deepEqual(planSave({}, null, { hide_on_screen_capture: true, 'plugins.daily_brief': true }, 'windows').effects, [{ kind: 'restartAvatar' }]);
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    let restarts = 0;
    const supervisor = { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }),
      restartAvatar: () => { restarts += 1; } } as OpsContext['supervisor'];
    const page = new PageSession(() => {});
    const call = (ops: ReturnType<typeof registry>, op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    const windows = registry({ ...context(dir), supervisor, platform: 'windows' });
    const read = await call(windows, 'settings.read');
    assert.ok(read.ok);
    assert.equal((read.value as { saved: Record<string, unknown> }).saved.capHide, false);
    assert.deepEqual(await call(windows, 'settings.save', { capHide: true }), { ok: true, value: { restart: 'avatar', notApplied: [] } });
    assert.equal(restarts, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).hide_on_screen_capture, true);
    const mac = registry({ ...context(dir), supervisor });
    assert.deepEqual(await call(mac, 'settings.save', { capHide: false }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.equal(restarts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a picked folder reaches agentd.request only as its handle, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-'));
  try {
    const ops = registry(context(dir)), page = new PageSession(() => {});
    const picked = await handle('main', page0, { op: 'files.pickFolder', args: [{ purpose: 'session_cwd' }] }, ops, page);
    assert.ok(picked.ok);
    const { handle: h, displayName } = picked.value as { handle: string; displayName: string };
    assert.equal(displayName, 'picked');
    assert.deepEqual(page.picked.get(h), { purpose: 'session_cwd', path: '/picked' });
    assert.deepEqual(await handle('main', page0, { op: 'files.pickFolder', args: [{ purpose: 'scope_file' }] }, ops, page),
      { ok: false, error: { code: 'invalid_args', detail: 'purpose' } });
    page.end();
    assert.equal(page.picked.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a scope reads only what the shell issued: a picked handle or the handle on a native drop card, never a path from the page',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scopes-'));
    try {
      const sent: unknown[] = [];
      const agentd = {
        request: async (_method: string, _path: string, body: unknown) => {
          sent.push(body);
          return { status: 201, body: Buffer.from(JSON.stringify({ scope_id: 's1', ...(body as object) })) };
        },
      } as unknown as OpsContext['agentd'];
      const cards: HandedItem[][] = [];
      const drops = new DropHandover({ desktop: () => ({ addDrop: (items) => cards.push(items), notice: () => {} }),
        importMotion: async () => ({ ok: true, action: {} }), log: () => {} });
      const ops = registry({ ...context(dir), agentd, dropped: drops.dropped }), page = new PageSession(() => {});
      const scope = async (body: unknown) =>
        (await handle('main', page0, { op: 'agentd.request', args: ['POST', '/agent/scopes', body] }, ops, page)) as
          { ok: true; value: { status: number; error?: { code: string; detail: string } } };
      const never = join(dir, 'never-picked');
      mkdirSync(never);
      assert.deepEqual((await scope({ files: [never] })).value, { status: 0, body: null, error: { code: 'handle_required', detail: 'files' } });
      assert.deepEqual(sent, [], 'a path no picker or drop issued never reaches agentd');

      drops.drop({ items: [{ kind: 'file', path: '/d/notes.md' }, { kind: 'text', text: 'hi' }], x: 0, y: 0, truncated: false });
      const item = cards[0]![0]!;
      assert.ok(item.kind === 'file' && typeof item.handle === 'string');
      assert.deepEqual(cards[0]![1], { kind: 'text', text: 'hi' });
      // Each of the card's actions may make a scope, from the stack and from the bubble.
      assert.equal((await scope({ files: [{ handle: item.handle }] })).value.status, 201);
      assert.equal((await scope({ files: [{ handle: item.handle }] })).value.status, 201);
      assert.deepEqual(sent, [{ files: ['/d/notes.md'] }, { files: ['/d/notes.md'] }]);
      assert.equal((await scope({ roots: [{ handle: item.handle }] })).value.error?.code, 'handle_required', 'a drop is no picked root');
      assert.equal((await scope({ files: [{ handle: 'MADE-UP' }] })).value.error?.code, 'handle_required');

      const picked = await handle('main', page0, { op: 'files.pickFile', args: [{ purpose: 'scope_file' }] }, ops, page);
      assert.ok(picked.ok);
      const h = (picked.value as { handle: string }).handle;
      assert.equal((await scope({ files: [{ handle: h }, { handle: item.handle }] })).value.status, 201);
      assert.deepEqual(sent.at(-1), { files: ['/picked/file', '/d/notes.md'] });
      assert.equal((await scope({ files: [{ handle: h }] })).value.error?.code, 'handle_required', 'a picked handle is used once');
      assert.equal(sent.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('a TTS address saved with another origin deletes the token installed for the old service, and the reply says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'services-'));
  try {
    const token = join(dir, 'tts-token.ref');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ services: { tts: { mode: 'url', url: 'http://127.0.0.1:19888' } } }));
    writeFileSync(token, 'first-reference\n', { mode: 0o600 });
    const ops = registry(context(dir)), page = new PageSession(() => {});
    const save = (url: string, mode = 'url') => handle('main', page0, { op: 'services.save', args: ['tts', { mode, url }] }, ops, page);
    assert.deepEqual(await save('http://127.0.0.1:19888/v2'), { ok: true, value: { ok: true } });
    assert.ok(existsSync(token), 'the same service');
    assert.deepEqual(await save('https://127.0.0.1:19888'), { ok: true, value: { ok: true, ttsTokenCleared: true } }, 'another scheme');
    assert.equal(readFileSync(join(dir, 'tts-token.revoked'), 'utf8').trim(), 'first-reference');
    assert.ok(!existsSync(token), 'the next start sends the first service\'s token to no one');
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).services.tts.url, 'https://127.0.0.1:19888');
    writeFileSync(token, 'second-reference\n', { mode: 0o600 });
    assert.deepEqual(await save('https://gpu-box:19888'), { ok: true, value: { ok: true, ttsTokenCleared: true } }, 'another host');
    assert.ok(!existsSync(token));
    assert.deepEqual(await save('https://gpu-box:19888', 'off'), { ok: true, value: { ok: true, ttsTokenCleared: true } }, 'off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TTS service reached through another SSH host, or switched between ssh, local and an address, deletes the old token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'services-'));
  try {
    const token = join(dir, 'tts-token.ref'), url = 'http://127.0.0.1:19888';
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ services: { tts: { mode: 'ssh', url, ssh_host: 'gpu-a' } } }));
    const ops = registry(context(dir)), page = new PageSession(() => {});
    const steps: [Record<string, unknown>, boolean][] = [
      [{ mode: 'ssh', ssh_host: 'gpu-a' }, false], [{ mode: 'ssh', ssh_host: 'gpu-b' }, true], [{ mode: 'local', command: ['serve'] }, true],
      [{ mode: 'local', command: ['serve', '--fast'] }, false], [{ mode: 'url' }, true], [{ mode: 'ssh', ssh_host: 'gpu-b' }, true],
    ];
    for (const [record, cleared] of steps) {
      writeFileSync(token, 'reference\n', { mode: 0o600 });
      const reply = await handle('main', page0, { op: 'services.save', args: ['tts', { url, ...record }] }, ops, page);
      assert.deepEqual(reply, { ok: true, value: { ok: true, ...(cleared && { ttsTokenCleared: true }) } }, JSON.stringify(record));
      assert.equal(existsSync(token), !cleared, JSON.stringify(record));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('services.save writes over config.json as it is once the start script is confirmed; unreadable by then, it writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'services-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{}');
    let meanwhile = JSON.stringify({ mute: true, services: { motion: { mode: 'url', url: 'http://gpu:48830' } } });
    const ops = registry({ ...context(dir), confirm: async () => { writeFileSync(path, meanwhile); return true; } });
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, new PageSession(() => {}));
    const ssh = { mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', start_script: '/opt/tts/ensure.sh' };
    assert.deepEqual(await call('services.save', 'tts', ssh), { ok: true, value: { ok: true } });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mute: true, services: { motion: { mode: 'url', url: 'http://gpu:48830' },
      tts: { ...ssh, command: [], cwd: '' } } });
    meanwhile = 'not json';
    assert.deepEqual(await call('services.save', 'tts', { ...ssh, ssh_host: 'other-box' }), { ok: true, value: { ok: false, error: 'config_unreadable' } });
    assert.equal(readFileSync(path, 'utf8'), 'not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a picked handle whose request never reached agentd stays the page\'s to send again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resend-'));
  try {
    let down = true;
    const sent: unknown[] = [];
    const agentd = {
      request: async (_method: string, _path: string, body: unknown) => {
        if (down) throw new Error('ECONNREFUSED');
        sent.push(body);
        return { status: 201, body: Buffer.from('{}') };
      },
    } as unknown as OpsContext['agentd'];
    const ops = registry({ ...context(dir), agentd }), page = new PageSession(() => {});
    const picked = await handle('main', page0, { op: 'files.pickFolder', args: [{ purpose: 'session_cwd' }] }, ops, page);
    assert.ok(picked.ok);
    const h = (picked.value as { handle: string }).handle;
    const send = async () => ((await handle('main', page0, { op: 'agentd.request', args: ['POST', '/sessions', { cwd: { handle: h } }] }, ops, page)) as
      { ok: true; value: { status: number; error?: { code: string } } }).value;
    assert.equal((await send()).error?.code, 'offline');
    assert.ok(page.picked.has(h));
    down = false;
    assert.equal((await send()).status, 201);
    assert.deepEqual(sent, [{ cwd: '/picked' }]);
    assert.ok(!page.picked.has(h), 'used once it arrived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a decision a page posts itself meets the stack\'s rules against agentd\'s live record: what needs a gesture asks natively', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decisions-'));
  try {
    const id = 'ab12', job = 'c'.repeat(32), sent: string[] = [], asked: string[] = [];
    let yes = false;
    const approval = (o: Record<string, unknown>) => ({ request_id: id, generation: 4, tool_name: 'Bash', tool_summary: 'rm -rf build',
      kind: 'tool', dangerous: false, options: ['allow', 'deny'], status: 'pending', ...o });
    let approvals: unknown[] = [];
    const interactions = [{ request_id: job, kind: 'approval', state: 'pending', revision: 2,
      data: { questions: [{ id: 'decision', question: '是否允许这一次操作？', options: [{ label: '允许' }, { label: '拒绝' }] }],
        preview_text: 'rm -rf out', dangerous: true } }];
    const agentd = {
      request: async (method: string, path: string) => {
        sent.push(`${method} ${path}`);
        const body = path === '/approvals' ? { approvals } : path === '/agent/interactions' ? { requests: interactions } : { ok: true };
        return { status: 200, body: Buffer.from(JSON.stringify(body)) };
      },
    } as unknown as OpsContext['agentd'];
    for (const surface of ['main', 'stack'] as const) {
      sent.length = 0;
      asked.length = 0;
      const ops = registry({ ...context(dir), surface, agentd, confirm: async (text) => { asked.push(text); return yes; } });
      const page = new PageSession(() => {});
      const post = async (path: string, body: unknown) =>
        ((await handle(surface, page0, { op: 'agentd.request', args: ['POST', path, body] }, ops, page)) as
          { ok: true; value: { status: number; error?: { code: string } } }).value;
      yes = false;
      approvals = [approval({ dangerous: true })];
      assert.equal((await post(`/approvals/${id}/decision`, { decision: 'allow', generation: 4 })).error?.code, 'declined', surface);
      assert.ok(asked[0]!.includes('rm -rf build'));
      assert.deepEqual(sent, ['GET /approvals'], 'no decision reaches agentd');
      assert.equal((await post(`/approvals/${id}/decision`, { decision: 'deny', generation: 4 })).status, 200, 'a deny needs no gesture');
      assert.equal(asked.length, 1);
      approvals = [approval({ kind: 'dispatch', dispatch: { mode: 'read_only', prompt: '修好测试' } })];
      assert.equal((await post(`/approvals/${id}/decision`, { decision: 'allow', generation: 4, mode: 'workspace_write' })).error?.code,
        'declined', 'a dispatch let write its workspace');
      assert.equal((await post(`/agent/interactions/${job}/answer`, { expected_version: 2, answers: { decision: ['允许'] } })).error?.code,
        'declined', 'a dangerous exact-call approval');
      assert.equal(asked.length, 3);
      assert.equal((await post(`/agent/interactions/${job}/answer`, { expected_version: 2, answers: { decision: ['拒绝'] } })).status, 200);
      approvals = [];
      assert.equal((await post(`/approvals/${id}/decision`, { decision: 'allow', generation: 4 })).error?.code, 'stale', 'no live approval');
      yes = true;
      approvals = [approval({ dangerous: true })];
      assert.equal((await post(`/approvals/${id}/decision`, { decision: 'allow', generation: 4 })).status, 200);
      assert.deepEqual(sent.filter((s) => s.startsWith('POST')), [`POST /approvals/${id}/decision`, `POST /agent/interactions/${job}/answer`,
        `POST /approvals/${id}/decision`]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a main-window message agentd took gets its T1 marks from the reply, timed from before it was sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marks-'));
  try {
    const id = 'a'.repeat(32), sent: number[] = [];
    const marks: [number, Record<string, unknown> | null, number][] = [];
    const agentd = {
      request: async (_method: string, path: string) => {
        sent.push(performance.now());
        const body = path.endsWith('/messages') ? { line_id: 'l1', trace_id: 't1', generation: 3 } : { ok: true };
        return { status: path.endsWith('/messages') ? 202 : 200, body: Buffer.from(JSON.stringify(body)) };
      },
    } as unknown as OpsContext['agentd'];
    const ctx: OpsContext = { ...context(dir), agentd,
      turnMarks: { acceptedBody: (status, body, at) => { marks.push([status, body, at.monoMs]); } } };
    const ops = registry(ctx), page = new PageSession(() => {});
    const request = (method: string, path: string, body?: unknown) =>
      handle('main', page0, { op: 'agentd.request', args: [method, path, body] }, ops, page);
    assert.ok((await request('POST', `/conversations/${id}/messages`, { text: 'hi' })).ok);
    assert.equal(marks.length, 1);
    assert.deepEqual(marks[0]!.slice(0, 2), [202, { line_id: 'l1', trace_id: 't1', generation: 3 }]);
    assert.ok(marks[0]![2] <= sent[0]!, 'submitted before the request went out');
    assert.ok((await request('POST', `/conversations/${id}/activate`)).ok);
    assert.equal(marks.length, 1, 'only a message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('open.* takes a POSIX absolute path on macOS and a drive-absolute one on Windows', () => {
  assert.ok(localPath('/Users/a/out.md', 'darwin'));
  assert.ok(!localPath('C:\\Users\\a\\out.md', 'darwin'));
  assert.ok(localPath('C:\\Users\\a\\out.md', 'win32'));
  assert.ok(localPath('d:\\x', 'win32'));
  for (const bad of ['/tmp/a.md', '\\\\server\\share\\a.md', 'C:a.md', 'a.md', 'C:\\a\\..\\b.md', 'C:\\a/../b.md', 'C:\\a\u0007.md',
    `C:\\${'x'.repeat(4094)}`]) {
    assert.ok(!localPath(bad, 'win32'), bad);
  }
});

test('a save that needs a new renderer restarts it on macOS too; frame-rate caps and hot keys reach the running shell', async () => {
  assert.deepEqual(planSave({}, null, { render_ssaa: false }, 'mac'),
    { write: { render_ssaa: false }, effects: [{ kind: 'restartAvatar' }], restart: 'avatar' });
  // The renderer reads 说话时有表情 only from its launch arguments.
  assert.deepEqual(planSave({}, null, { speech_expressions: false }, 'mac'),
    { write: { speech_expressions: false }, effects: [{ kind: 'restartAvatar' }], restart: 'avatar' });
  assert.deepEqual(planSave({}, null, { render_fps: '30' }, 'mac').effects, [{ kind: 'fps' }]);
  assert.deepEqual(planSave({}, null, { hotkey_quick_input: 'control+option+k' }, 'mac').effects,
    [{ kind: 'hotkeys', saved: [['hotkey_quick_input', 'control+option+k']] }]);
  // A key that moves to another changed one's old key registers again after the rest.
  assert.deepEqual(planSave({}, null, { hotkey_look: 'control+option+space', hotkey_quick_input: 'control+option+k' }, 'mac').effects,
    [{ kind: 'hotkeys', saved: [['hotkey_look', 'control+option+space'], ['hotkey_quick_input', 'control+option+k'],
      ['hotkey_look', 'control+option+space']] }]);
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const calls: string[] = [];
    const supervisor = { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }),
      restartAvatar: () => { calls.push('restart'); } } as OpsContext['supervisor'];
    const saved = { fps: () => { calls.push('fps'); }, hotkey: (key: string, name: string) => { calls.push(`${key}=${name}`); } };
    const ops = registry({ ...context(dir), supervisor, saved }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('settings.save', { 'rnd.aa': false }), { ok: true, value: { restart: 'avatar', notApplied: [] } });
    assert.deepEqual(await call('settings.save', { 'rnd.fps': '45', hk_quick: '⌃⌥K' }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(calls, ['restart', 'fps', 'hotkey_quick_input=control+option+k']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save of the touch switches or of live render settings reaches the running shell', async () => {
  for (const key of ['touch_regions', 'head_pat', 'cheek_pinch', 'greet_on_resume']) {
    // 捏脸 is off by default, the others on.
    assert.deepEqual(planSave({}, null, { [key]: key === 'cheek_pinch' }, 'mac').effects, [{ kind: 'touch' }], key);
  }
  assert.deepEqual(planSave({}, null, { render_outline: 'subtle', render_filter: 'filter_2', render_camera_yaw: 15 }, 'mac').effects,
    [{ kind: 'renderLive', keys: ['render_outline', 'render_camera_yaw', 'render_filter'] }]);
  // Into or out of 半身固定 changes the framing; a restart reads the new values itself.
  assert.deepEqual(planSave({}, null, { stay_mode: 'bust' }, 'mac').effects,
    [{ kind: 'behaviorSwitches', keys: ['stay_mode'] }, { kind: 'renderLive', keys: ['stay_mode'] }]);
  assert.deepEqual(planSave({ stay_mode: 'bust' }, null, { stay_mode: 'stay' }, 'mac').effects,
    [{ kind: 'behaviorSwitches', keys: ['stay_mode'] }, { kind: 'renderLive', keys: ['stay_mode'] }]);
  assert.deepEqual(planSave({}, null, { stay_mode: 'stay' }, 'mac').effects, [{ kind: 'behaviorSwitches', keys: ['stay_mode'] }]);
  assert.deepEqual(planSave({}, null, { render_outline: 'subtle', render_ssaa: false }, 'mac').effects, [{ kind: 'restartAvatar' }]);
  assert.deepEqual(planSave({}, null, { render_dof: 'closeup', cheek_pinch: true, greet_on_resume: false }, 'mac').effects,
    [{ kind: 'renderLive', keys: ['render_dof'] }, { kind: 'touch' }]);
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const calls: string[] = [];
    const saved = { fps: () => { calls.push('fps'); }, hotkey: () => {}, touch: () => { calls.push('touch'); },
      renderLive: (keys: string[]) => { calls.push(`renderLive=${keys.join(',')}`); } };
    const ops = registry({ ...context(dir), saved }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('settings.save', { 'beh.pat': false, 'rnd.outline': 'subtle' }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(calls, ['renderLive=render_outline', 'touch']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save of 看向鼠标 or 拖动惯性 sets that action switch: sent to the current character, stored for the others', async () => {
  assert.deepEqual(planSave({}, null, { look_at_cursor: false, drag_inertia: false }, 'mac').effects,
    [{ kind: 'actionSwitch', id: 'drag_sway', on: false }, { kind: 'actionSwitch', id: 'look_cursor', on: false }]);
  const dir = mkdtempSync(join(tmpdir(), 'switches-'));
  try {
    const character = (id: string) => ({ id, name: id, avatar_app: join(dir, 'Avatar.app') });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ agentd_dir: dir, python: process.execPath, agentd_port: 48810, gpu_hold_files: [],
      support_dir: dir, agentd_state_dir: join(dir, 'state'), characters: [character('si'), character('cedar'), character('ember'), character('lifeng')],
      action_switches: { si: { look_cursor: true, wave: true }, cedar: { wave: false }, lifeng: { drag_sway: true } } }));
    const sent: [string, Record<string, boolean>][] = [];
    const looks = { saveSwitches: async (c: string, switches: Record<string, boolean>) => {
      sent.push([c, switches]);
      return { character: c, switches, adjusted: [] };
    } } as unknown as OpsContext['looks'];
    const avatar = { currentCharacter: 'si' } as unknown as AvatarHost;
    const ops = registry({ ...context(dir), looks, avatar }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('settings.save', { 'beh.inertia': false }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(sent, [['si', { look_cursor: true, wave: true, drag_sway: false }]]);
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(file.drag_inertia, false);
    assert.deepEqual(file.action_switches, { si: { look_cursor: true, wave: true }, cedar: { wave: false, drag_sway: false },
      ember: { drag_sway: false }, lifeng: { drag_sway: false } });
    // Turning one on writes no table for a character without one: si's went only to the fake renderer.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...file, action_switches: {} }));
    assert.deepEqual(await call('settings.save', { 'beh.mouse': false }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(await call('settings.save', { 'beh.mouse': true }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).action_switches,
      { cedar: { look_cursor: true }, ember: { look_cursor: true }, lifeng: { look_cursor: true } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings.read offers 半身固定 when the connected renderer lists camera_bust', async () => {
  const statuses = async (avatar: AvatarHost | null) => {
    const read = await handle('main', page0, { op: 'settings.read', args: [] }, registry({ ...context(tmpdir()), avatar }), new PageSession(() => {}));
    assert.ok(read.ok);
    return (read.value as { statuses: Record<string, string> }).statuses;
  };
  const renderer = (capabilities: string[]) => ({ hello: { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities } }) as unknown as AvatarHost;
  assert.equal((await statuses(renderer(['actions', 'camera_bust'])))['beh.stay'], undefined);
  assert.equal((await statuses(renderer(['actions'])))['beh.stay'], '这个版本的角色还不支持半身固定');
  assert.equal((await statuses(null))['beh.stay'], '这个版本的角色还不支持半身固定');
});

test('settings.wipeLocalData empties the web log and keeps config.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wipe-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{"mute":true}');
    mkdirSync(join(dir, 'pasted'));
    writeFileSync(join(dir, 'pasted', 'private.png'), Buffer.from([1]));
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'ui.log'), 'error\n');
    writeFileSync(join(dir, 'logs', 'ui.log.1'), 'older\n');
    const agentd = { request: async () => ({ status: 200, body: Buffer.from('{"deleted":{}}') }) } as unknown as OpsContext['agentd'];
    const r = await handle('main', page0, { op: 'settings.wipeLocalData', args: [] }, registry({ ...context(dir), agentd }), new PageSession(() => {}));
    assert.deepEqual(r, { ok: true, value: null });
    assert.equal(existsSync(join(dir, 'pasted', 'private.png')), false);
    assert.deepEqual([readFileSync(join(dir, 'logs', 'ui.log'), 'utf8'), readFileSync(join(dir, 'logs', 'ui.log.1'), 'utf8')], ['', '']);
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"mute":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('services.save asks before a new start script, and a no writes nothing; an unchanged or cleared script is not asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const asked: string[] = [];
    let answer = false;
    const ops = registry({ ...context(dir), confirm: async (text: string) => { asked.push(text); return answer; } });
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, new PageSession(() => {}));
    const ssh = { mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', start_script: '/opt/tts/ensure.sh' };
    assert.deepEqual(await call('services.save', 'tts', ssh), { ok: true, value: { ok: false, error: 'declined' } });
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /\/opt\/tts\/ensure\.sh .*gpu-box/);
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{}');
    answer = true;
    assert.deepEqual(await call('services.save', 'tts', ssh), { ok: true, value: { ok: true } });
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).services.tts.start_script, '/opt/tts/ensure.sh');
    asked.length = 0;
    assert.deepEqual(await call('services.save', 'tts', ssh), { ok: true, value: { ok: true } });
    assert.deepEqual(await call('services.save', 'tts', { ...ssh, start_script: '' }), { ok: true, value: { ok: true } });
    assert.deepEqual(asked, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('services.save asks before a new local command or cwd, and a no writes nothing and starts nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ services: { llm: { mode: 'off', command: ['/bin/sh', '-c', 'x'] } } }));
    const asked: string[] = [], saved: string[] = [];
    let answer = false;
    const ops = registry({ ...context(dir), confirm: async (text: string) => { asked.push(text); return answer; },
      services: { view: () => ({ mode: 'off', state: null, pid: null, detail: null }), start: async () => ({ ok: true, line: null }),
        stop: async () => ({ ok: true, line: null }), restart: async () => ({ ok: true, line: null }), saved: (id) => { saved.push(id); } } });
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, new PageSession(() => {}));
    const local = { mode: 'local', url: 'http://127.0.0.1:11434/v1', command: ['/bin/sh', '-c', 'x'], cwd: '/srv' };
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    assert.deepEqual(await call('services.save', 'llm', local), { ok: true, value: { ok: false, error: 'declined' } }, 'off to local');
    assert.match(asked[0]!, /\/bin\/sh -c x.*\/srv/);
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
    assert.deepEqual(saved, []);
    answer = true;
    assert.deepEqual(await call('services.save', 'llm', local), { ok: true, value: { ok: true } });
    asked.length = 0;
    answer = false;
    assert.deepEqual(await call('services.save', 'llm', local), { ok: true, value: { ok: true } }, 'unchanged');
    assert.deepEqual(asked, []);
    assert.deepEqual(await call('services.save', 'llm', { ...local, command: ['/bin/sh', '-c', 'y'] }), { ok: true, value: { ok: false, error: 'declined' } });
    assert.deepEqual(await call('services.save', 'llm', { ...local, cwd: '/tmp' }), { ok: true, value: { ok: false, error: 'declined' } });
    assert.equal(asked.length, 2);
    assert.deepEqual(saved, ['llm', 'llm']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TTS token is revoked only once config.json holds the new address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'services-'));
  try {
    const token = join(dir, 'tts-token.ref'), path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ services: { tts: { mode: 'url', url: 'http://127.0.0.1:19888' } } }));
    writeFileSync(token, 'reference\n', { mode: 0o600 });
    // The temporary file config.json is written through cannot be made.
    mkdirSync(`${path}.tmp-${process.pid}`);
    const ops = registry(context(dir));
    const reply = await handle('main', page0, { op: 'services.save', args: ['tts', { mode: 'url', url: 'https://gpu-box:19888' }] }, ops, new PageSession(() => {}));
    assert.ok(reply.ok);
    assert.equal((reply.value as { error: string }).error, 'write_failed');
    assert.ok(existsSync(token), 'config.json still names the old service');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).services.tts.url, 'http://127.0.0.1:19888');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save of an agentd setting puts every live value to agentd and needs no restart; a refused put is not applied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ interaction_preset: 'loud' }));
    const got: unknown[] = [];
    let status = 200;
    const agentd = { request: async (method: string, path: string, json: unknown) => {
      got.push([method, path, json]);
      return { status, body: Buffer.from('{}') };
    } } as unknown as OpsContext['agentd'];
    const ops = registry({ ...context(dir), agentd }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.deepEqual(await call('settings.save', { mute: true }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(got, [['PUT', '/settings/live', {
      mute: true, proactive_speech: true, interaction_preset: 'balanced', redact_sensitive: true, share_page_text: false,
      share_window_text: false, share_typed_text: false, share_agent_sessions: true, share_screenshots: false }]]);
    status = 500;
    assert.deepEqual(await call('settings.save', { mute: false }), { ok: true, value: { restart: 'none', notApplied: ['mute'] } });
    assert.deepEqual(await call('settings.save', { 'plugins.daily_brief': true }), { ok: true, value: { restart: 'backend', notApplied: [] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a save whose effect throws fails alone: the next save still writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const saved = { fps: () => {}, hotkey: () => {}, touch: () => { throw new Error('touch port broke'); } };
    const ops = registry({ ...context(dir), saved }), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', page0, { op, args }, ops, page);
    assert.equal((await call('settings.save', { 'beh.pat': false })).ok, false);
    assert.deepEqual(await call('settings.save', { mute: true }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).mute, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadAvatar takes a new hello as her return even when the old one never read as gone', async () => {
  const hello = () => ({ v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['actions'] });
  const link: { hello: unknown } = { hello: hello() };
  // The new renderer's connection replaces the old one within one poll.
  const supervisor = { restartAvatar: () => { setTimeout(() => { link.hello = hello(); }, 10); } };
  const back = reloadAvatar({ supervisor, log: () => {} }, link as unknown as AvatarHost).then(() => 'back');
  assert.equal(await Promise.race([back, new Promise((r) => setTimeout(r, 2000, 'still waiting'))]), 'back');
});

test('the guide still answers when config.json is unreadable: not done, on step 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{ not json');
    const ops = registry({ ...context(dir), surface: 'onboarding' });
    const r = await handle('onboarding', page0, { op: 'onboarding.state', args: [] }, ops, new PageSession(() => {}));
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([(r.value as { done: boolean }).done, (r.value as { step: number }).step], [false, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop.onState hotkeys: each hot key row by web id as the page shows it, defaults included, a broken name left out', () => {
  assert.deepEqual(desktopHotkeys({ hotkey_quick_input: 'ctrl+alt+k', hotkey_look: 'bogus+' }),
    { hk_ptt: '右⌥', hk_quick: '⌃⌥K', hk_hide: '⌃⌥H', hk_pass: '⌃⌥P', hk_wheel: '⌃⌥R' });
  assert.deepEqual(desktopHotkeys({ hotkey_quick_input: 'command+shift+k', hotkey_look: 'bogus+' }, 'windows'),
    { hk_ptt: '右Alt', hk_quick: 'Shift+Win+K', hk_hide: 'Ctrl+Alt+H', hk_pass: 'Ctrl+Alt+P', hk_wheel: 'Ctrl+Alt+R' });
});

test('hot key statuses and refusals name Ctrl, Alt and Win on Windows and keep the macOS caps on macOS', () => {
  const refused = { hotkey_click_through: 'control+option+p' };
  const status = (platform: 'mac' | 'windows') =>
    (snapshot(refused, null, true, platform, refused) as { statuses: Record<string, string> }).statuses.hk_pass;
  assert.equal(status('mac'), '「⌃⌥P」没设上，可能被别的程序占用，请换一个');
  assert.equal(status('windows'), '「Ctrl+Alt+P」没设上，可能被别的程序占用，请换一个');
  const refusal = (id: string, combo: string, platform: 'mac' | 'windows') => {
    try {
      parseChanges({ [id]: combo }, () => {}, platform);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  };
  assert.equal(refusal('hk_ptt', '⇧K', 'mac'), '「按住说话」不能设成 ⇧K：要用带 ⌃、⌥ 或 ⌘ 的组合键，或 F1–F12，或 右⌥');
  assert.equal(refusal('hk_ptt', '⇧K', 'windows'), '「按住说话」不能设成 Shift+K：要用带 Ctrl、Alt 或 Win 的组合键，或 F1–F12，或 右Alt');
  assert.equal(refusal('hk_quick', '⌘⌘K', 'windows'), '「快速输入」不能设成 Win+Win+K：要用带 Ctrl、Alt 或 Win 的组合键，或 F1–F12');
});

test('avatar.details: photo, capture and filters count when she and the link both list them (WebAvatarWatch.details)', () => {
  const host = { hello: { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['photo', 'capture', 'filters'] },
    companionCapabilities: ['capture', 'filters'], lastPipeline: null, lastPlacement: null } as unknown as AvatarHost;
  const details = avatarDetails(host);
  assert.deepEqual([details.photo, details.capture, details.filters], [false, true, true]);
});

test('app.look answers; without a look, offline 屏幕识读不可用（配置出错）', async () => {
  const look = async (surface: 'main' | 'stack', result: OpsContext['look']) => handle(surface, page0, { op: 'app.look', args: [] },
    registry({ ...context(tmpdir()), surface, look: result }), new PageSession(() => {}));
  assert.deepEqual(await look('stack', async () => ({ kind: 'requested', requestId: 'look-1' })), { ok: true, value: { requestId: 'look-1' } });
  assert.deepEqual(await look('main', async () => ({ kind: 'requested', requestId: 'look-2' })), { ok: true, value: { requestId: 'look-2' } });
  assert.deepEqual(await look('stack', async () => ({ kind: 'blocked', reason: 'paused' })), { ok: false, error: { code: 'blocked', detail: 'paused' } });
  assert.deepEqual(await look('stack', async () => ({ kind: 'rejected', status: 503, error: 'busy' })),
    { ok: false, error: { code: 'failed', detail: 'POST /look status 503 busy' } });
  assert.deepEqual(await look('stack', async () => ({ kind: 'failed' })), { ok: false, error: { code: 'offline', detail: '' } });
  assert.deepEqual(await look('stack', null), { ok: false, error: { code: 'offline', detail: '屏幕识读不可用（配置出错）' } });
});
