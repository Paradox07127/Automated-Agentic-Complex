// A launch from the app bundle: distribution.json,
// the components, config.json in the support dir and the seed library; the character tools are a fake `run` port.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { rendererPreflight } from '../src/common/components.ts';
import { ConfigError, type ShellPlatform } from '../src/common/config.ts';
import { treeHash } from '../src/main/components.ts';
import { loadConfig } from '../src/main/config.ts';
import { nodePorts, packagedConfigPath, packagedContents, type PackagedPorts, preparePackaged, webRoot } from '../src/main/packaged.ts';
import { helperExecutable } from '../src/main/platform/index.ts';

const ID = 'local.agenticcomplex.distribution-test';
const ZERO = '0'.repeat(64);
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const posixModes = process.platform !== 'win32';

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'packaged-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A library `character_tool.py compose` would make: one text-only character `fixture`; `version` changes its bytes. */
function library(version: string): Record<string, string> {
  return {
    'current.json': JSON.stringify({ schema: 'endfield-character-library/v1', default_character: 'fixture',
      characters: [{ id: 'fixture', version, definition: { file: 'packages/fixture/character.json' } }] }),
    'packages/fixture/character.json': JSON.stringify({ id: 'fixture', display: { name: { 'zh-Hans': '测试角色' } } }),
  };
}

/** The agentd seed tools: compose writes `library(seed.version)` to `--output`; distribution_seed.py copies the seed there. */
function fakeTools(seed = { version: '1' }) {
  const calls: { tool: string; args: string[]; log?: string }[] = [];
  const ports: PackagedPorts = {
    run(_file, args, log) {
      calls.push({ tool: basename(args.find((a) => a.endsWith('.py'))!), args, log });
      const output = args[args.indexOf('--output') + 1]!;
      for (const [path, text] of Object.entries(library(seed.version))) write(join(output, path), text);
      return { status: 0, stderr: '' };
    },
  };
  return { calls, ports };
}

/**
 * An app at `<root>/Agentic Complex.app` as package_app.py lays it out: host and renderer placed in `Contents`; `portable`
 * puts every other component in `Resources/components` beside the lock, `split` keeps web-ui there and the rest in
 * `<root>/components` with `index.json`. On Windows the portable directory `<root>/Agentic Complex` takes the place of
 * `Contents`, with the exes in it and `resources` below it.
 */
function packagedApp(root: string, layout: 'portable' | 'split' = 'portable', os: ShellPlatform = 'mac') {
  const windows = os === 'windows';
  const app = join(root, windows ? 'Agentic Complex' : 'Agentic Complex.app'), contents = windows ? app : join(app, 'Contents');
  const resources = join(contents, windows ? 'resources' : 'Resources'), platform = windows ? 'windows-x64' : 'macos-arm64';
  const host = windows ? 'Agentic Complex.exe' : 'MacOS/AgenticComplex', renderer = windows ? 'efw.exe' : 'MacOS/AgenticComplexMetalAvatar';
  const parts: { id: string; entrypoints: Record<string, string>; placed?: Record<string, string>; files: Record<string, string> }[] = [
    { id: 'host', entrypoints: { executable: host }, placed: { [host]: host }, files: {} },
    { id: 'renderer', entrypoints: { executable: renderer }, placed: { [renderer]: renderer }, files: {} },
    { id: 'web-ui', entrypoints: { index: 'ui/main.html' }, files: { 'ui/main.html': '<p>', 'ui/art/brand/mark.png': 'png', 'ui-bridge/routes.json': '{}' } },
    windows ? { id: 'runtime.python', entrypoints: { python: 'python.exe' }, files: { 'python.exe': '' } }
      : { id: 'runtime.python', entrypoints: { python: 'bin/python3' }, files: { 'bin/python3': '#!/bin/sh\n' } },
    { id: 'agentd', entrypoints: { launcher: 'agentd_launcher.py' },
      files: { 'agentd_launcher.py': '', 'agentd/character_tool.py': '', 'agentd/distribution_seed.py': '' } },
    { id: 'harness.pi', entrypoints: { node: 'node/bin/node' }, files: { 'node/bin/node': '' } },
    { id: 'characters.fixture', entrypoints: {}, files: { 'character.json': '{"id": "fixture"}' } },
  ];
  const refs: Record<string, unknown>[] = [];
  for (const part of parts) {
    const beside = layout === 'split' && !['host', 'renderer', 'web-ui'].includes(part.id);
    const dir = join(beside ? root : resources, 'components', part.id), payload = join(dir, 'payload');
    for (const target of Object.values(part.placed ?? {})) write(join(contents, target), '', 0o755);
    mkdirSync(payload, { recursive: true });
    for (const [path, text] of Object.entries(part.files)) write(join(payload, path), text, path.startsWith('bin/') ? 0o755 : 0o644);
    const tree = part.placed ? { sha256: ZERO, files: 1, bytes: 0 } : treeHash(payload);
    write(join(dir, 'component.json'), JSON.stringify({
      schema: 'endfield-component/v1', id: part.id, version: '1', tree_sha256: tree.sha256, files: tree.files, bytes: tree.bytes,
      entrypoints: part.entrypoints, platform,
      // As tools/release/package_app.py and build_components.py declare them.
      provides: part.id === 'agentd' ? { C6: '1', C9: '1' } : {},
      requires: ({ host: { C6: '1', C9: '1' }, agentd: { 'runtime.python': '1' } } as Record<string, object>)[part.id] ?? {},
      ...(part.placed ? { placed: part.placed } : {}),
    }));
    if (part.placed) rmSync(payload, { recursive: true });
    if (part.id !== 'host') refs.push({ id: part.id, version: '1', tree_sha256: tree.sha256, ...(beside ? { dir: part.id } : { placement: 'bundle' }) });
  }
  if (layout === 'split') {
    write(join(root, 'components/index.json'), JSON.stringify({ schema: 'endfield-components-index/v1', components: refs.filter((r) => 'dir' in r) }));
  } else {
    write(join(resources, 'composition.lock.json'), JSON.stringify({ schema: 'endfield-composition/v1', edition: 'portable',
      platform, created_at: '2026-11-20T00:00:00Z', host: { id: 'host', version: '1', tree_sha256: ZERO }, components: refs }));
  }
  const distribution = { schema: 'endfield-distribution/v3', id: ID, layout, port: 48810,
    catalogSHA256: sha256(library('1')['current.json']!), defaultCharacter: 'fixture' as string | null };
  write(join(resources, 'distribution.json'), JSON.stringify(distribution));
  const supportBase = join(root, 'support');
  return {
    app, contents, resources, bundle: join(resources, 'components'), supportBase, support: join(supportBase, ID),
    options: { resources, supportBase, agentdStateDir: join(root, 'agentd-state'), platform: os },
    edit(change: (d: typeof distribution) => void) {
      change(distribution);
      write(join(resources, 'distribution.json'), JSON.stringify(distribution));
    },
  };
}

const readJSON = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('a portable app writes a fresh config from its components with the defaults and seeds the library once', (t) => {
  const app = packagedApp(temp(t)), tools = fakeTools();
  const launch = preparePackaged(app.options, tools.ports)!;
  const configPath = join(app.support, 'config.json');
  assert.equal(launch.configPath, configPath);
  assert.equal(packagedConfigPath(app.resources, app.supportBase), configPath);
  const saved = readJSON(configPath);
  const seeded = join(app.support, 'character-libraries', `seed-${sha256(library('1')['current.json']!).slice(0, 16)}`);
  assert.deepEqual(saved, {
    agentd_port: 48810, gpu_hold_files: [], characters: [],
    voice_hotkey: 'right_option', hotkey_quick_input: 'control+option+space', hotkey_look: 'control+option+l',
    hotkey_toggle_avatar: 'control+option+h', hotkey_click_through: 'control+option+p', hotkey_radial_menu: '',
    hotkey_selection: 'control+option+s', viewport: 'fullscreen',
    sense_input_counts: false, sense_audio_apps: false,
    share_page_text: false, share_window_text: false, share_typed_text: false, share_actions: false, share_agent_sessions: true,
    share_screenshots: false,
    proactive_speech: false, mute: false, voice_service: 'local', tts_url: '', tts_tunnel_host: '',
    system_notifications: false, hide_on_screen_capture: true,
    character_catalog: join(seeded, 'current.json'),
    avatar_app: app.app,
    avatar_executable: join(app.contents, 'MacOS/AgenticComplexMetalAvatar'),
    agentd_dir: join(app.bundle, 'agentd/payload/agentd'),
    python: join(app.bundle, 'runtime.python/payload/bin/python3'),
    agentd_launcher: join(app.bundle, 'agentd/payload/agentd_launcher.py'),
    harness_sites: { 'harness.pi': join(app.bundle, 'harness.pi/payload') },
    support_dir: app.support, agentd_state_dir: app.options.agentdStateDir,
  });
  assert.deepEqual(Object.keys(saved), Object.keys(saved).sort());
  assert.deepEqual(readJSON(join(seeded, 'distribution-seed.json')),
    { schema: 'endfield-distribution-seed/v1', seed_sha256: sha256(library('1')['current.json']!) });
  assert.deepEqual(tools.calls.map((c) => c.args.slice(1)), [['compose', '--package', join(app.bundle, 'characters.fixture/payload'),
    '--default', 'fixture', '--output', tools.calls[0]!.args.at(-1)!]]);
  assert.equal(tools.calls[0]!.tool, 'character_tool.py');
  assert.equal(dirname(tools.calls[0]!.args.at(-1)!), app.support);
  assert.deepEqual(readdirSync(app.support).filter((n) => n.startsWith('.characters-')), []);
  if (posixModes) {
    assert.equal(statSync(app.support).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(launch.composition.missing, {});
  assert.equal(launch.webRoot, join(app.bundle, 'web-ui/payload/ui'));
  assert.equal(webRoot(app.resources, launch), launch.webRoot);
  const config = loadConfig(configPath, 'mac');
  assert.equal(config.character, 'fixture');
  assert.equal(config.agentdLauncher, join(app.bundle, 'agentd/payload/agentd_launcher.py'));
  assert.equal(rendererPreflight(config), null);

  // The library is there: a broken python is not run again, and the unchanged config is not rewritten.
  const before = readFileSync(configPath, 'utf8');
  assert.equal(preparePackaged(app.options, tools.ports)!.configPath, configPath);
  assert.equal(tools.calls.length, 1);
  assert.equal(readFileSync(configPath, 'utf8'), before);
});

test('a split app imports the components beside it into the support dir and keeps them without the index', (t) => {
  const root = temp(t), app = packagedApp(root, 'split'), tools = fakeTools();
  const installed = join(app.support, 'components');
  const launch = preparePackaged(app.options, tools.ports)!;
  const saved = readJSON(launch.configPath);
  const python = String(saved.python), agentd = String(saved.agentd_dir);
  assert.ok(python.startsWith(join(installed, 'runtime.python', '1-')), python);
  assert.ok(agentd.startsWith(join(installed, 'agentd', '1-')), agentd);
  assert.ok(String(saved.agentd_launcher).startsWith(join(installed, 'agentd', '1-')));
  assert.equal(saved.avatar_executable, join(app.contents, 'MacOS/AgenticComplexMetalAvatar'));
  assert.equal(launch.webRoot, join(app.bundle, 'web-ui/payload/ui'));
  assert.equal('missing_components' in saved, false);
  assert.ok(tools.calls[0]!.args[0]!.startsWith(join(installed, 'agentd', '1-')), tools.calls[0]!.args[0]);
  assert.ok(String(saved.character_catalog).startsWith(join(app.support, 'character-libraries/seed-')));

  rmSync(join(root, 'components'), { recursive: true });
  const again = readJSON(preparePackaged(app.options, tools.ports)!.configPath);
  assert.equal(again.python, python);
  assert.equal(again.agentd_dir, agentd);
});

test('missing components: the config lists them with empty paths, a placeholder character until the seed library can be built', (t) => {
  const root = temp(t), app = packagedApp(root), tools = fakeTools();
  const agentd = join(app.bundle, 'agentd/payload'), away = join(root, 'agentd-payload');
  renameSync(agentd, away);
  rmSync(join(app.bundle, 'web-ui'), { recursive: true });
  const launch = preparePackaged(app.options, tools.ports)!;
  const saved = readJSON(launch.configPath);
  assert.deepEqual(saved.missing_components, { agentd: 'componentMissing', 'web-ui': 'componentMissing' });
  assert.deepEqual([saved.agentd_dir, saved.agentd_launcher], ['', '']);
  assert.equal(saved.python, join(app.bundle, 'runtime.python/payload/bin/python3'));
  assert.equal(saved.avatar_executable, join(app.contents, 'MacOS/AgenticComplexMetalAvatar'));
  assert.equal(launch.webRoot, null);
  assert.equal(webRoot(app.resources, launch), null);
  assert.equal('character_catalog' in saved, false);
  assert.deepEqual(saved.character_library_missing, ['agentd']);
  assert.deepEqual(saved.characters, [{ id: 'fixture', name: 'fixture', avatar_app: app.app, avatar_args: [] }]);
  assert.deepEqual(tools.calls, []);
  assert.match(readFileSync(join(app.support, 'logs/companion.log'), 'utf8'), /companion: seed library not built: agentd/);
  assert.deepEqual(rendererPreflight(loadConfig(launch.configPath, 'mac')), { kind: 'failed', reason: '没有角色库：缺 agentd 组件' });

  // Once agentd is back the library is built and the placeholder gives way to its roster.
  renameSync(away, agentd);
  const rebuilt = readJSON(preparePackaged(app.options, tools.ports)!.configPath);
  assert.equal('character_library_missing' in rebuilt, false);
  assert.deepEqual(rebuilt.missing_components, { 'web-ui': 'componentMissing' });
  const config = loadConfig(launch.configPath, 'mac');
  assert.deepEqual(config.characters.map((c) => [c.id, c.name]), [['fixture', '测试角色']]);
});

test('an existing config keeps the user settings, and a gone catalog is reseeded', (t) => {
  const root = temp(t), app = packagedApp(root), tools = fakeTools();
  const configPath = preparePackaged(app.options, tools.ports)!.configPath;
  const seeded = readJSON(configPath).character_catalog;
  const gone = join(root, 'Deleted.app/Contents/Resources/characters/current.json');
  const own = { ...readJSON(configPath), character_catalog: gone, mute: true, hotkey_quick_input: '', model_preference: { custom: true },
    support_dir: join(root, 'own-support'), agentd_state_dir: join(root, 'own-state'), python: '/old/python', avatar_app: '/Old.app' };
  write(configPath, JSON.stringify(own));
  preparePackaged(app.options, tools.ports);
  const after = readJSON(configPath);
  assert.equal(after.character_catalog, seeded);
  assert.equal(after.mute, true);
  assert.equal(after.hotkey_quick_input, '');
  assert.deepEqual(after.model_preference, { custom: true });
  assert.equal(after.support_dir, join(root, 'own-support'));
  assert.equal(after.agentd_state_dir, join(root, 'own-state'));
  assert.equal(after.python, join(app.bundle, 'runtime.python/payload/bin/python3'));
  assert.equal(after.avatar_app, app.app);
  const log = readFileSync(join(root, 'own-support/logs/companion.log'), 'utf8');
  assert.equal(log.split(`ERROR config character_catalog missing: ${gone}`).length, 2, log);
  assert.equal(tools.calls.length, 1);
});

test('a changed seed migrates through distribution_seed.py and drops the superseded generation', (t) => {
  const root = temp(t), app = packagedApp(root), seed = { version: '1' }, tools = fakeTools(seed);
  const configPath = preparePackaged(app.options, tools.ports)!.configPath;
  const first = String(readJSON(configPath).character_catalog), prior = sha256(readFileSync(first));
  seed.version = '2';
  const hash = sha256(library('2')['current.json']!);
  app.edit((d) => { d.catalogSHA256 = hash; });
  preparePackaged(app.options, tools.ports);
  const next = join(app.support, 'character-libraries', `seed-${hash.slice(0, 16)}-from-${prior.slice(0, 16)}`);
  assert.equal(readJSON(configPath).character_catalog, join(next, 'current.json'));
  const migrate = tools.calls.at(-1)!;
  assert.equal(migrate.tool, 'distribution_seed.py');
  assert.equal(migrate.log, join(app.support, 'seed-migration.log'));
  assert.deepEqual(migrate.args.slice(1), ['--seed-catalog', join(tools.calls.at(-2)!.args.at(-1)!, 'current.json'), '--seed-sha256', hash,
    '--existing-catalog', first, '--existing-sha256', prior, '--output', next,
    '--validate-with', join(app.contents, 'MacOS/AgenticComplexMetalAvatar')]);
  assert.deepEqual(readdirSync(join(app.support, 'character-libraries')), [basename(next)]);
  assert.deepEqual(readdirSync(app.support).filter((n) => n.startsWith('.characters-')), []);
});

test('a changed seed with a seed component missing keeps the existing library until a launch that has them all', (t) => {
  const root = temp(t), app = packagedApp(root), seed = { version: '1' }, tools = fakeTools(seed);
  const configPath = preparePackaged(app.options, tools.ports)!.configPath;
  const first = String(readJSON(configPath).character_catalog);
  seed.version = '2';
  app.edit((d) => { d.catalogSHA256 = sha256(library('2')['current.json']!); });
  const agentd = join(app.bundle, 'agentd/payload'), away = join(root, 'agentd-payload');
  renameSync(agentd, away);
  preparePackaged(app.options, tools.ports);
  assert.equal(readJSON(configPath).character_catalog, first);
  assert.equal(tools.calls.length, 1);
  assert.match(readFileSync(join(app.support, 'logs/companion.log'), 'utf8'), /companion: seed migration deferred: agentd/);
  renameSync(away, agentd);
  preparePackaged(app.options, tools.ports);
  assert.notEqual(readJSON(configPath).character_catalog, first);
  assert.equal(tools.calls.at(-1)!.tool, 'distribution_seed.py');
});

/** `dir` as a library after an upgrade of `a` from `sha0`: current.json names only `packages/a/<sha1>`, the rest is superseded. */
function upgradedLibrary(dir: string): void {
  const sha1 = '1'.repeat(64);
  write(join(dir, 'current.json'), JSON.stringify({ schema: 'endfield-character-library/v1', default_character: 'a', revision: 'r1',
    native_bundle: { file: 'native-cur.json' }, characters: [{ id: 'a', definition: { file: `packages/a/${sha1}/character.json` } }] }));
  write(join(dir, `packages/a/${sha1}/character.json`), JSON.stringify({ id: 'a', display: { name: { 'zh-Hans': '甲' } } }));
  for (const path of [`packages/a/${'0'.repeat(64)}/character.json`, `packages/gone/${'2'.repeat(64)}/character.json`,
    'catalog-old.json', 'catalog-r1.json', 'native-old.json', 'native-cur.json', 'outfit-imports/a/imports.json']) write(join(dir, path), '{}');
}

test('a launch drops the package directories, catalogs and native bundles its own library current.json no longer names', (t) => {
  const app = packagedApp(temp(t)), tools = fakeTools();
  const configPath = preparePackaged(app.options, tools.ports)!.configPath;
  const seeded = dirname(String(readJSON(configPath).character_catalog));
  upgradedLibrary(seeded);
  preparePackaged(app.options, tools.ports);
  assert.equal(readJSON(configPath).character_catalog, join(seeded, 'current.json'));
  assert.deepEqual(readdirSync(join(seeded, 'packages')), ['a']);
  assert.deepEqual(readdirSync(join(seeded, 'packages/a')), ['1'.repeat(64)]);
  assert.deepEqual(readdirSync(seeded).sort(),
    ['catalog-r1.json', 'current.json', 'distribution-seed.json', 'native-cur.json', 'outfit-imports', 'packages']);
  assert.ok(existsSync(join(seeded, 'outfit-imports/a/imports.json')));
});

test('a launch removes nothing through a linked package directory or a linked library', (t) => {
  const root = temp(t), app = packagedApp(root), tools = fakeTools();
  const configPath = preparePackaged(app.options, tools.ports)!.configPath;
  const seeded = dirname(String(readJSON(configPath).character_catalog)), sha1 = '1'.repeat(64);
  upgradedLibrary(seeded);
  const linkedPackage = join(root, 'linked-package');
  write(join(linkedPackage, 'photos/keep.txt'), 'mine');
  renameSync(join(seeded, 'packages/a', sha1), join(linkedPackage, sha1));
  rmSync(join(seeded, 'packages/a'), { recursive: true });
  symlinkSync(linkedPackage, join(seeded, 'packages/a'), 'junction');
  preparePackaged(app.options, tools.ports);
  assert.deepEqual(readdirSync(linkedPackage).sort(), [sha1, 'photos'], 'the directory behind the link keeps its unrelated directory');
  assert.deepEqual(readdirSync(join(seeded, 'packages')), ['a'], 'the rest of the library is still pruned');

  const linkedLibrary = join(root, 'linked-library');
  rmSync(join(seeded, 'packages/a'));
  renameSync(linkedPackage, join(seeded, 'packages/a'));
  renameSync(seeded, linkedLibrary);
  symlinkSync(linkedLibrary, seeded, 'junction');
  write(join(linkedLibrary, `packages/gone/${'2'.repeat(64)}/keep.txt`), 'mine');
  preparePackaged(app.options, tools.ports);
  assert.ok(existsSync(join(linkedLibrary, `packages/gone/${'2'.repeat(64)}/keep.txt`)), 'a linked library is not pruned');
  assert.deepEqual(readdirSync(join(linkedLibrary, 'packages/a')).sort(), [sha1, 'photos']);
});

test('a launch leaves a user catalog outside the support dir alone', (t) => {
  const root = temp(t), app = packagedApp(root), tools = fakeTools();
  const configPath = preparePackaged(app.options, tools.ports)!.configPath;
  const own = join(root, 'own-library');
  upgradedLibrary(own);
  write(join(own, 'distribution-seed.json'), readFileSync(join(dirname(String(readJSON(configPath).character_catalog)), 'distribution-seed.json'), 'utf8'));
  write(configPath, JSON.stringify({ ...readJSON(configPath), character_catalog: join(own, 'current.json') }));
  const before = readdirSync(own, { recursive: true }).map(String).sort();
  preparePackaged(app.options, tools.ports);
  assert.equal(readJSON(configPath).character_catalog, join(own, 'current.json'));
  assert.deepEqual(readdirSync(own, { recursive: true }).map(String).sort(), before);
});

test('a composed seed other than catalogSHA256 fails before any config or library is written', (t) => {
  const app = packagedApp(temp(t));
  app.edit((d) => { d.catalogSHA256 = ZERO; });
  assert.throws(() => preparePackaged(app.options, fakeTools().ports), (e) => e instanceof ConfigError && e.message === '发行角色目录 SHA 不匹配');
  assert.equal(existsSync(join(app.support, 'config.json')), false);
  assert.equal(existsSync(join(app.support, 'character-libraries')), false);
  const failing: PackagedPorts = { run: () => ({ status: 1, stderr: 'no package' }) };
  assert.throws(() => preparePackaged(app.options, failing), (e) => e instanceof ConfigError && e.message === '发行角色库合成失败：no package');
});

test('without distribution.json (the repo) nothing is prepared; another schema is refused', (t) => {
  const root = temp(t), resources = join(root, 'Electron.app/Contents/Resources');
  mkdirSync(resources, { recursive: true });
  assert.equal(preparePackaged({ resources, supportBase: join(root, 'support'), agentdStateDir: join(root, 's'), platform: 'mac' },
    fakeTools().ports), null);
  assert.equal(packagedConfigPath(resources, join(root, 'support')), null);
  assert.equal(packagedContents(resources), null);
  assert.equal(webRoot(resources, null), null);
  assert.equal(existsSync(join(root, 'support')), false);

  const app = packagedApp(join(root, 'v2'));
  assert.equal(packagedContents(app.resources), app.contents);
  // A `--config` launch of the app still serves its bundled web-ui.
  assert.equal(webRoot(app.resources, null), join(app.bundle, 'web-ui/payload/ui'));
  for (const change of [{ schema: 'endfield-distribution/v2' }, { layout: 'flat' }, { id: 'Local' }, { port: 80 }, { catalogSHA256: 1 }]) {
    app.edit((d) => Object.assign(d, { schema: 'endfield-distribution/v3', layout: 'portable', id: ID, port: 48810, catalogSHA256: ZERO }, change));
    assert.throws(() => packagedConfigPath(app.resources, app.supportBase), (e) => e instanceof ConfigError && e.message === '无效的发行配置',
      JSON.stringify(change));
    assert.throws(() => preparePackaged(app.options, fakeTools().ports), ConfigError, JSON.stringify(change));
  }
});

test('the helper of a packaged app is its Contents/MacOS/ac-helper; the repo keeps the build output', () => {
  assert.equal(helperExecutable('/r/app', 'darwin', '/A.app/Contents'), '/A.app/Contents/MacOS/ac-helper');
  assert.equal(helperExecutable('/r/app', 'darwin', null), '/r/app/helpers/mac/.build/release/ac-helper');
  assert.equal(helperExecutable('C:\\r\\app', 'win32', 'C:\\AC'), 'C:\\AC\\ac-helper.exe');
});

test('a Windows portable directory: its exes beside resources, the component Python run with -I -B, captures show her, no split layout', (t) => {
  const app = packagedApp(temp(t), 'portable', 'windows'), tools = fakeTools();
  assert.equal(packagedContents(app.resources), app.contents);
  const launch = preparePackaged(app.options, tools.ports)!;
  const saved = readJSON(launch.configPath);
  assert.equal('missing_components' in saved, false);
  assert.equal(saved.hide_on_screen_capture, false);
  assert.equal(saved.avatar_app, app.contents);
  assert.equal(saved.avatar_executable, join(app.contents, 'efw.exe'));
  assert.equal(saved.python, join(app.bundle, 'runtime.python/payload/python.exe'));
  assert.equal(launch.webRoot, join(app.bundle, 'web-ui/payload/ui'));
  assert.deepEqual(tools.calls[0]!.args.slice(0, 3), ['-I', '-B', join(app.bundle, 'agentd/payload/agentd/character_tool.py')]);
  assert.throws(() => preparePackaged({ ...app.options, platform: 'mac' }, tools.ports),
    (e) => e instanceof ConfigError && e.message === '组件无法使用：composition.lock.json lockInvalid');
  app.edit((d) => { d.layout = 'split'; });
  assert.throws(() => preparePackaged(app.options, tools.ports), (e) => e instanceof ConfigError && e.message === '无效的发行配置');
});

test('the run port: stderr comes back without a log, both streams go to the log with one', (t) => {
  const dir = temp(t), log = join(dir, 'tool.log');
  const script = 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)';
  assert.deepEqual(nodePorts.run(process.execPath, ['-e', script]), { status: 3, stderr: 'err\n' });
  writeFileSync(log, 'before\n');
  assert.deepEqual(nodePorts.run(process.execPath, ['-e', script], log), { status: 3, stderr: '' });
  assert.equal(readFileSync(log, 'utf8'), 'before\nout\nerr\n');
});
