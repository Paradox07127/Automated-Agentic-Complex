import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentdArguments } from '../src/common/agentd.ts';
import { type Catalog, CatalogError, type ConfigContext, configLogLine, launchCharacter, parseConfig } from '../src/common/config.ts';
import {
  configPathFromArgs, DEFAULT_AGENTD_STATE_DIR, DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR, loadConfig, quitAfterFromArgs, supportDirOf,
} from '../src/main/config.ts';
import { defaultDirs } from '../src/main/platform/index.ts';
import { hostSocketPath } from '../src/main/renderer/link.ts';
import { rendererArguments } from '../src/main/renderer/supervisor.ts';

const EMPTY_LIBRARY = fileURLToPath(new URL('../../../protocol/character-library/fixtures/empty-library/current.json', import.meta.url));
const BASE = { agentd_dir: '/a/agentd', python: '/a/python', agentd_port: 48810, gpu_hold_files: [] };
const ASTER = { ...BASE, characters: [{ id: 'aster', name: '示例甲', avatar_app: '/A.app' }] };

function ctx(catalog: Catalog | null = null): ConfigContext {
  return { supportDir: '/support', agentdStateDir: '/state', catalog: () => catalog };
}

const parse = (o: unknown, c = ctx()) => parseConfig(JSON.stringify(o), c);
const fails = (o: unknown, message: string, c = ctx()) => assert.throws(() => parse(o, c), { message }, message);

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'config-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an empty character library is a valid config: no characters, no character, agentd started without --character', () => {
  withTemp((dir) => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ...BASE, character_catalog: EMPTY_LIBRARY, support_dir: dir }));
    const config = loadConfig(path);
    assert.deepEqual(config.characters, []);
    assert.equal(config.character, '');
    assert.equal(config.avatarApp, '');
    assert.equal(config.characterCatalog, EMPTY_LIBRARY);
    const args = agentdArguments(config, { launcherScript: 'l.py', parentPid: 1, character: launchCharacter(config, 'aster') });
    assert.ok(!args.includes('--character'));
    assert.deepEqual(args.slice(args.indexOf('--character-catalog'), args.indexOf('--character-catalog') + 2), ['--character-catalog', EMPTY_LIBRARY]);
  });
});

test('required keys are reported as 缺少字段', () => {
  for (const key of Object.keys(BASE)) {
    const o: Record<string, unknown> = { ...BASE, characters: [{ id: 'a', name: 'A', avatar_app: '/A.app' }] };
    delete o[key];
    fails(o, `缺少字段 ${key}`);
  }
  fails(BASE, '缺少字段 characters');
  fails({ ...BASE, characters: [{ name: 'A', avatar_app: '/A.app' }] }, '缺少字段 id');
});

test('values of the wrong type are 字段 <path> 类型错误, with coding paths', () => {
  fails({ ...ASTER, agentd_port: '48810' }, '字段 agentd_port 类型错误');
  fails({ ...ASTER, agentd_port: null }, '字段 agentd_port 类型错误');
  fails({ ...ASTER, gpu_hold_files: ['/x', 1] }, '字段 gpu_hold_files.Index 1 类型错误');
  fails({ ...ASTER, characters: [{ id: 3, name: 'A', avatar_app: '/A.app' }] }, '字段 characters.Index 0.id 类型错误');
  fails({ ...ASTER, harness_sites: { 'harness.pi': 1 } }, '字段 harness_sites.harness.pi 类型错误');
  fails({ ...ASTER, share_page_text: 'yes' }, '字段 share_page_text 类型错误');
  fails({ ...ASTER, redact_sensitive: 'no' }, '字段 redact_sensitive 类型错误');
  fails({ ...ASTER, break_reminder_minutes: '25' }, '字段 break_reminder_minutes 类型错误');
  // Keys this shell does not read are not checked.
  assert.equal(parse({ ...ASTER, voice_hotkey: 1, screen_context_level: 1, battery_low_fps: 'x', viewport: 1, notify_done: 1,
    system_notifications: 'x' }).character, 'aster');
  assert.throws(() => parseConfig('{', ctx()), { message: 'JSON 无效' });
});

test('characters: empty, unknown selection, and the library errors', () => {
  fails({ ...BASE, characters: [] }, 'characters 为空');
  fails({ ...BASE, characters: [{ id: 'a', name: 'A', avatar_app: '/A.app' }], character: 'b' }, '角色 b 不在 characters 里');
  fails({ ...BASE, character_catalog: '/lib/current.json' }, '角色目录不存在：/lib/current.json');
  const rendered: Catalog = { characters: [{ id: 'a', name: 'A', renderEnabled: true }], defaultCharacterID: 'a' };
  fails({ ...BASE, character_catalog: '/lib/current.json' }, '角色目录需要 avatar_app', ctx(rendered));
  const broken: ConfigContext = { ...ctx(), catalog: () => { throw new CatalogError('unsupported_catalog_schema'); } };
  fails({ ...BASE, character_catalog: '/lib/current.json' }, '角色目录无效：unsupported_catalog_schema', broken);
  const textOnly: Catalog = { characters: [{ id: 'a', name: 'A', renderEnabled: false }, { id: 'b', name: 'B', renderEnabled: false }],
    defaultCharacterID: 'b' };
  const config = parse({ ...BASE, character_catalog: '/lib/current.json' }, ctx(textOnly));
  assert.equal(config.character, 'b');
  assert.deepEqual(config.characters[0], { id: 'a', name: 'A', avatarApp: '', avatarArgs: ['--character-catalog', '/lib/current.json'],
    renderEnabled: false });
});

/** A library of `aster` (bundle entry with `d3d11_frame`), `birch` (none, a stale `d3d11/frame.bin` on disk, unless
 * `framed` names it) and text-only `aide`. */
function writeD3D11Library(dir: string, framed = ['aster']): { catalog: string; aster: string; birch: string } {
  const library = join(dir, 'library');
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(join(library, file)), { recursive: true });
    writeFileSync(join(library, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const ref = (file: string) => ({ file, sha256: '0'.repeat(64), byte_count: 0 });
  write('current.json', { schema: 'endfield-character-library/v1', default_character: 'aster', characters: ['aster', 'birch', 'aide']
    .map((id) => ({ id, definition: ref(`packages/${id}/${id[0]!.repeat(64)}/character.json`) })) });
  for (const id of ['aster', 'birch']) {
    write(`packages/${id}/${id[0]!.repeat(64)}/character.json`, { id, display: { name: { 'zh-Hans': id } },
      components: { render: { native_bundle: ref('runtime/bundle.json') } } });
    write(`packages/${id}/${id[0]!.repeat(64)}/runtime/bundle.json`, { schema: 'metal-native-character-bundle/v1', characters: [{ id,
      graph: ref(`characters/${id}/graph/frame-graph.json`), ...(framed.includes(id) ? { d3d11_frame: ref(`characters/${id}/d3d11/frame.bin`) } : {}) }] });
  }
  write(`packages/birch/${'birch'[0]!.repeat(64)}/runtime/characters/birch/d3d11/frame.bin`, 'stale');
  write(`packages/aide/${'a'.repeat(64)}/character.json`, { id: 'aide', display: { name: { 'zh-Hans': 'aide' } }, components: {} });
  return { catalog: join(library, 'current.json'), aster: join(library, `packages/aster/${'aster'[0]!.repeat(64)}/runtime/characters/aster`),
    birch: join(library, `packages/birch/${'birch'[0]!.repeat(64)}/runtime/characters/birch`) };
}

test('Windows: a library character launches efw with --package <its character directory> only when its bundle entry has d3d11_frame', () => {
  withTemp((dir) => {
    const { catalog, aster } = writeD3D11Library(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ...BASE, avatar_app: '/efw', character_catalog: catalog, support_dir: dir }));
    const windows = loadConfig(path, 'windows');
    assert.deepEqual(windows.characters.map((c) => [c.id, c.avatarArgs, c.renderEnabled]),
      [['aster', ['--package', aster, '--package-of', `aster=${aster}`], true], ['birch', [], false], ['aide', [], false]]);
    const args = rendererArguments({ config: windows, settings: {}, state: {}, character: 'aster', parentPid: 1, startupPath: '/s',
      socketPath: '\\\\.\\pipe\\p', captureDir: '/c', platform: 'windows' });
    assert.deepEqual(args.slice(-6), ['--package', aster, '--package-of', `aster=${aster}`, '--agentic-complex-host-socket', '\\\\.\\pipe\\p']);
    assert.ok(!args.includes('--character-catalog'));
    // macOS: every character gets the library, as before.
    assert.deepEqual(loadConfig(path, 'mac').characters.map((c) => [c.id, c.avatarArgs, c.renderEnabled]),
      [['aster', ['--character-catalog', catalog], true], ['birch', ['--character-catalog', catalog], true],
        ['aide', ['--character-catalog', catalog], false]]);
  });
});

test('Windows: efw gets --package-of <id>=<character directory> for every character it can draw, so set_character needs no restart', () => {
  withTemp((dir) => {
    const { catalog, aster, birch } = writeD3D11Library(dir, ['aster', 'birch']);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ...BASE, avatar_app: '/efw', character_catalog: catalog, support_dir: dir }));
    const both = ['--package-of', `aster=${aster}`, '--package-of', `birch=${birch}`];
    // The text-only aide has no d3d11_frame, so it is in no list.
    assert.deepEqual(loadConfig(path, 'windows').characters.map((c) => [c.id, c.avatarArgs, c.renderEnabled]),
      [['aster', ['--package', aster, ...both], true], ['birch', ['--package', birch, ...both], true], ['aide', [], false]]);
    assert.deepEqual(loadConfig(path, 'mac').characters.map((c) => c.avatarArgs),
      [['--character-catalog', catalog], ['--character-catalog', catalog], ['--character-catalog', catalog]]);
  });
});

test('the missing-file errors and their companion.log lines', () => {
  assert.throws(() => loadConfig('/nonexistent/e1c/config.json'), { message: '找不到配置文件 /nonexistent/e1c/config.json' });
  try {
    parse({ ...BASE, character_catalog: '/lib/current.json' });
    assert.fail('expected a ConfigError');
  } catch (e) {
    assert.equal(configLogLine(e), 'ERROR config character_catalog missing: /lib/current.json');
  }
  assert.equal(configLogLine(new Error('characters 为空')), 'ERROR config characters 为空');
});

test('defaults of Config', () => {
  const c = parse(ASTER);
  assert.equal(c.character, 'aster');
  assert.equal(c.supportDir, '/support');
  assert.equal(c.agentdStateDir, '/state');
  assert.equal(c.interactionPreset, 'balanced');
  assert.equal(c.ttsURL, 'http://127.0.0.1:9888');
  assert.deepEqual([c.shareAgentSessions, c.redactSensitive, c.proactiveSpeech], [true, true, true]);
  assert.deepEqual([c.sharePageText, c.shareTypedText, c.shareActions, c.mute], [false, false, false, false]);
  assert.equal(parse({ ...ASTER, share_actions: true }).shareActions, true);
  assert.equal(c.breakReminderMinutes, 0);
  // agentd's own default, so a config.json without the key keeps today's reminders.
  assert.equal(c.waterReminderMinutes, 90);
  assert.equal(c.agentdLauncher, null);
  const d = parse({ ...ASTER, interaction_preset: 'loud', break_reminder_minutes: 25, water_reminder_minutes: 120,
    voice_service: 'local', tts_url: 'http://h:1', tts_tunnel_host: 'h' });
  assert.equal(d.interactionPreset, 'balanced');
  assert.equal(d.breakReminderMinutes, 25);
  assert.equal(d.waterReminderMinutes, 120);
  assert.equal(parse({ ...ASTER, water_reminder_minutes: 0 }).waterReminderMinutes, 0);
  assert.deepEqual([d.ttsURL, d.ttsTunnelHost], ['', '']);
  assert.equal(parse({ ...ASTER, voice_service: 'system', tts_url: 'http://h:1' }).ttsURL, 'http://h:1');
});

test('the config path comes from --config, else the installed support dir; support_dir falls back to the installed one or the given one', () => {
  assert.equal(configPathFromArgs(['electron', '.', '--config', '/t/config.json']), '/t/config.json');
  assert.equal(configPathFromArgs(['electron', '.']), join(DEFAULT_SUPPORT_DIR, 'config.json'));
  assert.deepEqual({ supportDir: DEFAULT_SUPPORT_DIR, agentdStateDir: DEFAULT_AGENTD_STATE_DIR, webLogsDir: DEFAULT_WEB_LOGS_DIR }, defaultDirs());
  assert.equal(quitAfterFromArgs(['electron', '.', '--quit-after', '30']), 30);
  for (const bad of [[], ['--quit-after'], ['--quit-after', '0'], ['--quit-after', '601'], ['--quit-after', '1.5'], ['--quit-after', '-3']]) {
    assert.equal(quitAfterFromArgs(['electron', '.', ...bad]), null, bad.join(' '));
  }
  withTemp((dir) => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{"support_dir": "/elsewhere"}');
    assert.equal(supportDirOf(path, DEFAULT_SUPPORT_DIR), '/elsewhere');
    writeFileSync(path, 'not json');
    assert.equal(supportDirOf(path, DEFAULT_SUPPORT_DIR), DEFAULT_SUPPORT_DIR);
    assert.equal(supportDirOf(path, dir), dir);
  });
});

test('two configs in different directories without support_dir take the one lock of the support dir whose C3 path they share', () => {
  withTemp((dir) => {
    const paths = ['a', 'b'].map((name) => {
      const path = join(dir, name, 'config.json');
      mkdirSync(dirname(path));
      writeFileSync(path, JSON.stringify(ASTER));
      return path;
    });
    // Electron keeps its single-instance lock in userData, `<support dir>/electron`.
    const locks = paths.map((path) => join(supportDirOf(path, DEFAULT_SUPPORT_DIR), 'electron'));
    const sockets = paths.map((path) => hostSocketPath(loadConfig(path).supportDir, 501));
    assert.equal(sockets[0], sockets[1]);
    assert.equal(locks[0], locks[1]);
    assert.equal(supportDirOf(paths[0]!, DEFAULT_SUPPORT_DIR), loadConfig(paths[0]!).supportDir);
  });
});

test("the installed app's directories: ~/Library on macOS; on Windows %APPDATA%, and agentd's state under %LOCALAPPDATA%, outside it", () => {
  assert.deepEqual(defaultDirs('darwin', {}, '/Users/a'), { supportDir: '/Users/a/Library/Application Support/local.agenticcomplex.companion',
    agentdStateDir: '/Users/a/Library/Application Support/AgenticComplex/agentd', webLogsDir: '/Users/a/Library/Logs/AgenticComplex' });
  const windows = defaultDirs('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a');
  assert.deepEqual(windows, { supportDir: 'C:\\Users\\a\\AppData\\Roaming\\Agentic Complex',
    agentdStateDir: 'C:\\Users\\a\\AppData\\Local\\Agentic Complex\\agentd', webLogsDir: 'C:\\Users\\a\\AppData\\Local\\Agentic Complex\\Logs' });
  assert.equal(defaultDirs('win32', {}, 'C:\\Users\\a').webLogsDir, 'C:\\Users\\a\\AppData\\Local\\Agentic Complex\\Logs');
  assert.ok(!windows.agentdStateDir.toLowerCase().startsWith(`${windows.supportDir.toLowerCase()}\\`));
});
