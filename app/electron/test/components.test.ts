// C11 resolution, import and tree hash, the
// config.json fields a packaged launch writes, the renderer's failure states and the tray's child rows (docs/components.md §5).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Backoff, preflightFailure } from '../src/common/agentd.ts';
import {
  ComponentFailure, componentPlatform, ImportFailure, menuLines, parseIndex, parseLock, parseManifest, rendererExit, rendererPreflight,
} from '../src/common/components.ts';
import { ConfigError, parseConfig } from '../src/common/config.ts';
import { installComponents, prepareComponents, resolveComponents, treeHash, writeComposition } from '../src/main/components.ts';
import { loadConfig } from '../src/main/config.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const EXAMPLES = join(REPO, 'protocol/C11-components/examples');
const example = (name: string) => readFileSync(join(EXAMPLES, name), 'utf8');
const SHA = (c: string) => c.repeat(64);

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'components-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** tools/release/component_manifest.py's tree hash, the build's reference. */
function pythonTreeHash(dir: string): string {
  // Windows has no python3; the gate gives the host's Python as AGENTD_PYTHON.
  const python = process.platform === 'win32' ? process.env.AGENTD_PYTHON ?? 'python' : 'python3';
  return execFileSync(python, ['-I', join(REPO, 'tools/release/component_manifest.py'), 'hash', dir], { encoding: 'utf8' }).trim();
}

interface Spec {
  version?: string;
  sha?: string;
  entrypoints?: Record<string, string>;
  provides?: Record<string, string>;
  requires?: Record<string, string>;
  placed?: Record<string, string>;
}

function manifest(id: string, spec: Spec, tree = { sha256: spec.sha ?? SHA('a'), files: 0, bytes: 0 }, platform = 'macos-arm64'): string {
  return JSON.stringify({
    schema: 'endfield-component/v1', id, version: spec.version ?? '1.0.0', tree_sha256: tree.sha256, files: tree.files,
    bytes: tree.bytes, entrypoints: spec.entrypoints ?? {}, provides: spec.provides ?? {}, requires: spec.requires ?? {},
    platform, ...(spec.placed ? { placed: spec.placed } : {}),
  });
}

/** A portable app at `<root>/Agentic Complex.app` whose lock lists host, renderer, web-ui, runtime.python and agentd. */
function portableApp(root: string, skip: string[] = [], platform = 'macos-arm64') {
  const contents = join(root, 'Agentic Complex.app/Contents'), resources = join(contents, 'Resources');
  const bundle = join(resources, 'components');
  const specs: Record<string, Spec> = {
    host: { sha: SHA('c'), entrypoints: { executable: 'MacOS/AgenticComplex' }, placed: { 'MacOS/AgenticComplex': 'MacOS/AgenticComplex' },
      requires: { C6: '1' } },
    renderer: { sha: SHA('e'), entrypoints: { executable: 'MacOS/AgenticComplexMetalAvatar' },
      placed: { 'MacOS/AgenticComplexMetalAvatar': 'MacOS/AgenticComplexMetalAvatar' } },
    'web-ui': { sha: SHA('f') },
    'runtime.python': { version: '3.13.9', sha: SHA('d'), entrypoints: { python: 'bin/agentic-complex-python' } },
    agentd: { sha: SHA('a'), entrypoints: { launcher: 'agentd_launcher.py' }, provides: { C6: '1' },
      requires: { 'runtime.python': '3.13.9' } },
  };
  write(join(contents, 'MacOS/AgenticComplex'), '', 0o755);
  write(join(contents, 'MacOS/AgenticComplexMetalAvatar'), '', 0o755);
  write(join(bundle, 'web-ui/payload/ui/main.html'), '');
  write(join(bundle, 'runtime.python/payload/bin/agentic-complex-python'), '', 0o755);
  write(join(bundle, 'agentd/payload/agentd_launcher.py'), '');
  write(join(bundle, 'agentd/payload/agentd/server.py'), '');
  for (const [id, spec] of Object.entries(specs)) {
    if (!skip.includes(id)) write(join(bundle, id, 'component.json'), manifest(id, spec, undefined, platform));
  }
  const ref = (id: string) => ({ id, version: specs[id]!.version ?? '1.0.0', tree_sha256: specs[id]!.sha });
  const lock = { schema: 'endfield-composition/v1', edition: 'portable', platform, created_at: '2026-11-19T00:00:00Z',
    host: ref('host'), components: ['renderer', 'web-ui', 'runtime.python', 'agentd'].map((id) => ({ ...ref(id), placement: 'bundle' })) };
  write(join(resources, 'composition.lock.json'), JSON.stringify(lock));
  return { contents, resources, bundle, lock: join(resources, 'composition.lock.json'), support: join(root, 'support') };
}

const missingOf = (failures: ComponentFailure[]) => Object.fromEntries(failures.map((f) => [f.component, f.reason]));

test('the C11 examples: the ok ones parse, the bad ones fail with the reader reason', () => {
  for (const name of ['ok-portable.composition.lock.json', 'ok-split.composition.lock.json']) {
    assert.equal(parseLock(example(name), 'macos-arm64').host.id, 'host', name);
  }
  assert.deepEqual(parseLock(example('ok-split.composition.lock.json'), 'macos-arm64').components.map((c) => [c.id, c.placement]),
    [['agentd', 'support'], ['browser', 'support'], ['characters.aster', 'support'], ['harness.pi', 'support'],
      ['renderer', 'bundle'], ['runtime.python', 'support'], ['web-ui', 'bundle']]);
  for (const name of ['bad-duplicate-id.json', 'bad-placement.json']) {
    assert.throws(() => parseLock(example(name), 'macos-arm64'), (e) => e instanceof ComponentFailure && e.reason === 'lockInvalid', name);
  }
  assert.throws(() => parseLock('{', 'macos-arm64'), (e) => e instanceof ComponentFailure && e.component === null && e.reason === 'lockInvalid');
  const lock = JSON.parse(example('ok-portable.composition.lock.json'));
  for (const created of ['2026-02-30T00:00:00Z', '2026-11-19T24:00:00Z', '2026-11-19 00:00:00Z']) {
    assert.throws(() => parseLock(JSON.stringify({ ...lock, created_at: created }), 'macos-arm64'), ComponentFailure, created);
  }
  assert.throws(() => parseLock(JSON.stringify({ ...lock, host: { ...lock.host, tree_sha256: 'c' } }), 'macos-arm64'),
    (e) => e instanceof ComponentFailure && e.component === 'host');

  for (const name of ['ok-host.component.json', 'ok-renderer.component.json', 'ok-agentd.component.json',
    'ok-characters.aster.component.json']) {
    assert.notEqual(parseManifest(example(name), 'macos-arm64'), null, name);
  }
  for (const name of ['bad-sha.json', 'bad-missing-key.json', 'bad-placed-agentd.component.json', 'bad-placed-path.component.json',
    'bad-placed-type.component.json']) {
    assert.equal(parseManifest(example(name), 'macos-arm64'), null, name);
  }
  const agentd = JSON.parse(example('ok-agentd.component.json'));
  for (const bad of [{ files: true }, { files: -1 }, { bytes: 1.5 }, { entrypoints: { launcher: '../x' } }, { entrypoints: { '': 'x' } },
    { requires: { 'runtime.python': '>=3' } }, { provides: { c6: '1' } }, { placed: {} }, { platform: 'windows-x64' }]) {
    assert.equal(parseManifest(JSON.stringify({ ...agentd, ...bad }), 'macos-arm64'), null, JSON.stringify(bad));
  }

  assert.deepEqual(parseIndex(example('ok-index.json')).map((e) => e.dir),
    ['agentd', 'browser', 'characters.aster', 'harness.pi', 'runtime.python']);
  assert.throws(() => parseIndex(example('bad-index-dir.json')), (e) => e instanceof ImportFailure && e.reason === 'indexInvalid');
  const index = JSON.parse(example('ok-index.json'));
  assert.throws(() => parseIndex(JSON.stringify({ ...index, components: [{ ...index.components[0], id: 'renderer' }] })),
    (e) => e instanceof ImportFailure && e.component === 'renderer');
});

test('treeHash matches the build tool on files, exec bits, links and the excluded entries', (t) => {
  const root = join(temp(t), 'payload');
  write(join(root, 'component.json'), 'not hashed at the root');
  write(join(root, 'sub/component.json'), 'hashed below it');
  write(join(root, 'bin/tool'), '#!/bin/sh\n', 0o755);
  write(join(root, 'Zeta.txt'), 'z');
  write(join(root, 'zeta/ä.txt'), 'umlaut');
  write(join(root, 'zeta/b.txt'), 'b');
  write(join(root, '.hidden'), 'h');
  write(join(root, '.DS_Store'), 'x');
  write(join(root, 'deep/__pycache__/m.pyc'), 'x');
  symlinkSync('../missing/target', join(root, 'zeta/link'));
  symlinkSync('bin', join(root, 'dirlink'));
  const tree = treeHash(root);
  assert.equal(tree.sha256, pythonTreeHash(root));
  assert.deepEqual([tree.files, tree.bytes], [8, 34]);
  // Windows files have no exec bits for chmod to set.
  if (process.platform !== 'win32') {
    chmodSync(join(root, 'Zeta.txt'), 0o744);
    assert.notEqual(treeHash(root).sha256, tree.sha256);
    assert.equal(treeHash(root).sha256, pythonTreeHash(root));
  }
  const empty = join(dirname(root), 'empty');
  mkdirSync(empty);
  assert.equal(treeHash(empty).sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('a complete portable composition resolves every component and its entrypoints', (t) => {
  const app = portableApp(temp(t));
  const { components, failures } = resolveComponents(app.lock, app.bundle, join(app.support, 'components'), 'macos-arm64');
  assert.deepEqual(failures, []);
  assert.deepEqual(components.map((c) => c.id), ['host', 'renderer', 'web-ui', 'runtime.python', 'agentd']);
  const renderer = components.find((c) => c.id === 'renderer')!;
  assert.equal(renderer.payload, app.contents);
  assert.equal(renderer.entrypoints.executable, join(app.contents, 'MacOS/AgenticComplexMetalAvatar'));
  assert.equal(components.find((c) => c.id === 'agentd')!.entrypoints.launcher, join(app.bundle, 'agentd/payload/agentd_launcher.py'));
});

test('each failing component gets its reason; one that requires it is requirementUnmet', (t) => {
  const missingPython = portableApp(join(temp(t), 'a'), ['runtime.python']);
  let r = resolveComponents(missingPython.lock, missingPython.bundle, join(missingPython.support, 'components'), 'macos-arm64');
  assert.deepEqual(missingOf(r.failures), { 'runtime.python': 'componentMissing', agentd: 'requirementUnmet' });
  // The host runs without the C6 provider; that provider is already missing.
  assert.deepEqual(r.components.map((c) => c.id), ['host', 'renderer', 'web-ui']);

  const app = portableApp(join(temp(t), 'b'));
  write(join(app.bundle, 'web-ui/component.json'), '{"schema": "endfield-component/v1"}');
  write(join(app.bundle, 'renderer/component.json'), manifest('renderer', { sha: SHA('9'), entrypoints: {} }));
  rmSync(join(app.bundle, 'agentd/payload/agentd_launcher.py'));
  r = resolveComponents(app.lock, app.bundle, join(app.support, 'components'), 'macos-arm64');
  assert.deepEqual(missingOf(r.failures), { 'web-ui': 'manifestInvalid', renderer: 'manifestMismatch', agentd: 'entrypointMissing' });

  // An entrypoint that leaves the payload through a link does not count.
  const escaping = portableApp(join(temp(t), 'c'));
  rmSync(join(escaping.bundle, 'agentd/payload/agentd_launcher.py'));
  symlinkSync(join(escaping.contents, 'MacOS/AgenticComplex'), join(escaping.bundle, 'agentd/payload/agentd_launcher.py'));
  r = resolveComponents(escaping.lock, escaping.bundle, join(escaping.support, 'components'), 'macos-arm64');
  assert.deepEqual(missingOf(r.failures), { agentd: 'entrypointMissing' });

  const noHost = portableApp(join(temp(t), 'd'), ['host']);
  assert.throws(() => resolveComponents(noHost.lock, noHost.bundle, join(noHost.support, 'components'), 'macos-arm64'),
    (e) => e instanceof ComponentFailure && e.component === 'host' && e.reason === 'componentMissing');
});

test('prepare writes missing_components and empty paths into config.json, and the supervisor does not start agentd', (t) => {
  const app = portableApp(temp(t), ['agentd']);
  const configPath = join(app.support, 'config.json');
  write(configPath, JSON.stringify({ agentd_port: 48999, gpu_hold_files: [], support_dir: app.support, mute: true,
    agentd_dir: '/old', python: '/old/python', characters: [{ id: 'aster', name: '示例甲', avatar_app: '/Old.app' }] }));
  const composition = prepareComponents({ resources: app.resources, support: app.support, layout: 'portable', platform: 'mac' });
  assert.deepEqual(composition.missing, { agentd: 'componentMissing' });
  writeComposition(configPath, composition);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(written.missing_components, { agentd: 'componentMissing' });
  assert.equal(written.agentd_dir, '');
  assert.equal(written.agentd_launcher, '');
  assert.equal(written.python, join(app.bundle, 'runtime.python/payload/bin/agentic-complex-python'));
  assert.equal(written.avatar_executable, join(app.contents, 'MacOS/AgenticComplexMetalAvatar'));
  assert.equal(written.mute, true);
  const config = loadConfig(configPath);
  assert.deepEqual(preflightFailure(config), { kind: 'failed', reason: '缺 agentd 组件' });
  assert.equal(rendererPreflight(config), null);

  const whole = portableApp(join(app.support, '..', 'whole'));
  writeComposition(configPath, prepareComponents({ resources: whole.resources, support: app.support, layout: 'portable', platform: 'mac' }));
  assert.equal('missing_components' in JSON.parse(readFileSync(configPath, 'utf8')), false);
});

test('a split import installs checked copies, logs the ones that fail and writes the lock', (t) => {
  const root = temp(t), source = join(root, 'components'), support = join(root, 'support');
  const app = portableApp(root);
  const entries: { id: string; version: string; tree_sha256: string; manifest_sha256: string; dir: string }[] = [];
  const external = (id: string, version: string, files: Record<string, string>, spec: Spec, tamper = false) => {
    const payload = join(source, id, 'payload');
    for (const [path, text] of Object.entries(files)) write(join(payload, path), text, path.startsWith('bin/') ? 0o755 : 0o644);
    const tree = { sha256: pythonTreeHash(payload), files: Object.keys(files).length,
      bytes: Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0) };
    write(join(source, id, 'component.json'), manifest(id, { ...spec, version }, tree));
    if (tamper) write(join(payload, Object.keys(files)[0]!), 'changed after the build');
    entries.push({ id, version, tree_sha256: tree.sha256, manifest_sha256: createHash('sha256').update(readFileSync(join(source, id, 'component.json'))).digest('hex'), dir: id });
  };
  external('runtime.python', '3.13.9', { 'bin/agentic-complex-python': '#!/bin/sh\n' }, { entrypoints: { python: 'bin/agentic-complex-python' } });
  external('agentd', '1.0.0', { 'agentd_launcher.py': 'x', 'agentd/server.py': 'y' },
    { entrypoints: { launcher: 'agentd_launcher.py' }, provides: { C6: '1' }, requires: { 'runtime.python': '3.13.9' } }, true);
  write(join(source, 'index.json'), JSON.stringify({ schema: 'endfield-components-index/v1', components: entries }));
  for (const id of ['runtime.python', 'agentd']) rmSync(join(app.bundle, id), { recursive: true });

  write(join(app.resources, 'components-index.json'), readFileSync(join(source, 'index.json'), 'utf8'));
  assert.deepEqual(installComponents(source, app.bundle, support, 'macos-arm64').failed, { agentd: 'treeMismatch' });
  const python = entries[0]!;
  const installed = join(support, 'components/runtime.python', `3.13.9-${python.tree_sha256.slice(0, 8)}`);
  assert.equal(treeHash(join(installed, 'payload')).sha256, python.tree_sha256);
  const lock = parseLock(readFileSync(join(support, 'components/composition.lock.json'), 'utf8'), 'macos-arm64');
  assert.equal(lock.edition, 'split');
  assert.deepEqual(lock.components.map((c) => [c.id, c.placement]),
    [['renderer', 'bundle'], ['web-ui', 'bundle'], ['runtime.python', 'support'], ['agentd', 'support']]);

  rmSync(join(app.resources, 'composition.lock.json'));
  const composition = prepareComponents({ resources: app.resources, support, layout: 'split', platform: 'mac' });
  assert.deepEqual(composition.missing, { agentd: 'componentMissing' });
  assert.equal(composition.python, join(installed, 'payload/bin/agentic-complex-python'));
  assert.match(readFileSync(join(support, 'logs/companion.log'), 'utf8'), /supervisor: component import failed: agentd treeMismatch/);

  // A broken index stops the launch, even with the lock of an earlier launch there.
  write(join(source, 'index.json'), '{');
  assert.throws(() => prepareComponents({ resources: app.resources, support, layout: 'split', platform: 'mac' }), /组件导入失败/);
});

test('the lock and manifests are the running platform\'s: windows-x64 on Windows, macos-arm64 on macOS', (t) => {
  assert.deepEqual([componentPlatform('windows'), componentPlatform('mac')], ['windows-x64', 'macos-arm64']);
  const lockInvalid = (e: unknown) => e instanceof ComponentFailure && e.component === null && e.reason === 'lockInvalid';
  const mac = example('ok-portable.composition.lock.json'), windows = JSON.stringify({ ...JSON.parse(mac), platform: 'windows-x64' });
  assert.equal(parseLock(windows, 'windows-x64').platform, 'windows-x64');
  assert.throws(() => parseLock(windows, 'macos-arm64'), lockInvalid);
  assert.throws(() => parseLock(mac, 'windows-x64'), lockInvalid);
  const agentd = example('ok-agentd.component.json');
  assert.equal(parseManifest(JSON.stringify({ ...JSON.parse(agentd), platform: 'windows-x64' }), 'windows-x64')?.platform, 'windows-x64');
  assert.equal(parseManifest(agentd, 'windows-x64'), null);

  const root = temp(t), app = portableApp(root, [], 'windows-x64'), support = join(root, 'support');
  const { components, failures } = resolveComponents(app.lock, app.bundle, join(support, 'components'), 'windows-x64');
  assert.deepEqual([components.length, failures], [5, []]);
  assert.throws(() => resolveComponents(app.lock, app.bundle, join(support, 'components'), 'macos-arm64'), lockInvalid);
  const source = join(root, 'components');
  write(join(source, 'index.json'), JSON.stringify({ schema: 'endfield-components-index/v1', components: [] }));
  write(join(app.resources, 'components-index.json'), readFileSync(join(source, 'index.json'), 'utf8'));
  assert.deepEqual(installComponents(source, app.bundle, support, 'windows-x64').failed, {});
  assert.equal(JSON.parse(readFileSync(join(support, 'components/composition.lock.json'), 'utf8')).platform, 'windows-x64');
  // The split layout's components beside the app are a macOS bundle's.
  assert.throws(() => prepareComponents({ resources: app.resources, support, layout: 'split', platform: 'windows' }),
    (e) => e instanceof ConfigError && e.message === '无效的发行配置');
});

const baseConfig = (extra: Record<string, unknown>) => parseConfig(JSON.stringify({
  agentd_dir: '/a', python: '/p', agentd_port: 48999, gpu_hold_files: [], support_dir: '/s', characters: [{ id: 'aster', name: '示例甲', avatar_app: '/A.app' }], ...extra,
}), { supportDir: '/s', agentdStateDir: '/st', catalog: () => null });

test('the renderer: a missing component or library fails it, exit 78 and 69 fail it without a restart', () => {
  assert.deepEqual(rendererPreflight(baseConfig({ missing_components: { renderer: 'componentMissing' } })),
    { kind: 'failed', reason: '缺 renderer 组件' });
  assert.deepEqual(rendererPreflight(baseConfig({ character_library_missing: ['agentd', 'characters.aster'] })),
    { kind: 'failed', reason: '没有角色库：缺 agentd characters.aster 组件' });
  assert.equal(rendererPreflight(baseConfig({ missing_components: { agentd: 'componentMissing' } })), null);
  const backoff = new Backoff(() => 0);
  assert.deepEqual(rendererExit(78, null, backoff), { kind: 'failed', reason: '角色包与程序版本不符' });
  assert.deepEqual(rendererExit(69, null, backoff), { kind: 'failed', reason: '无法使用 GPU' });
  assert.deepEqual(rendererExit(1, null, backoff), { kind: 'backoff', seconds: 1 });
  assert.deepEqual(rendererExit(null, 'SIGKILL', backoff), { kind: 'backoff', seconds: 2 });
});

test('the tray has a row per child, as docs/components.md §5 words them', () => {
  const stopped = { kind: 'stopped' } as const;
  const missing = (ids: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const config = baseConfig({ missing_components: ids, ...extra });
    return menuLines(config, rendererPreflight(config) ?? stopped, preflightFailure(config) ?? stopped);
  };
  assert.deepEqual(missing({ renderer: 'componentMissing' }), ['角色 · 失败：缺 renderer 组件', '后台 · 未启动']);
  assert.deepEqual(missing({ agentd: 'componentMissing' }), ['角色 · 未启动', '后台 · 失败：缺 agentd 组件']);
  const tunnel = { voice_service: 'remote', tts_url: 'http://127.0.0.1:9880', tts_tunnel_host: 'gpu-box' };
  assert.deepEqual(missing({ 'runtime.python': 'componentMissing', agentd: 'requirementUnmet' }, tunnel),
    ['角色 · 未启动', '后台 · 失败：缺 agentd 组件', '语音隧道 · 失败：缺 runtime.python 组件']);
  assert.deepEqual(missing({}, tunnel), ['角色 · 未启动', '后台 · 未启动', '语音隧道 · 未启动']);
  assert.deepEqual(missing({}, { character_library_missing: ['characters.aster'] }),
    ['角色 · 失败：没有角色库：缺 characters.aster 组件', '后台 · 失败：没有角色库：缺 characters.aster 组件']);
});
