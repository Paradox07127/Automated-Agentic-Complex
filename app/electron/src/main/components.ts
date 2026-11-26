// The C11 files on disk: the tree hash, finding each component's
// payload and entrypoints, the split app's import, and the config.json fields a packaged launch writes.
import { createHash, randomUUID } from 'node:crypto';
import {
  constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import {
  BUNDLED, ComponentFailure, type ComponentPlatform, componentPlatform, dropUnmet, ImportFailure, type Lock, type LockEntry, type Manifest, parseIndex,
  parseLock, parseManifest, type Reason,
} from '../common/components.ts';
import { ConfigError, type ShellPlatform } from '../common/config.ts';
import { appendLog } from './log.ts';

export interface Tree { sha256: string; files: number; bytes: number }

/** The tree hash of a payload, with the manifest's `files` and `bytes` for the same entries. */
export function treeHash(root: string, externalID?: string): Tree {
  const entries: { path: string; link: boolean; exec: boolean; size: number }[] = [], pending = [''];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const name of readdirSync(join(root, dir))) {
      // Python can execute cached bytecode even with -B, and C11 excludes it from the digest.
      if (name === '__pycache__' && externalID !== undefined) throw new ImportFailure(externalID, 'treeMismatch');
      if (name === '.DS_Store' || name === '__pycache__' || (dir === '' && name === 'component.json')) continue;
      const path = dir === '' ? name : `${dir}/${name}`, info = lstatSync(join(root, path));
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile() || info.isSymbolicLink()) {
        entries.push({ path, link: info.isSymbolicLink(), exec: (info.mode & 0o111) !== 0, size: info.size });
      } else throw new Error(`unsupported entry ${path}`);
    }
  }
  // UTF-8 byte order, not UTF-16 code unit order.
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  let bytes = 0;
  const records = entries.map((e) => {
    const full = join(root, e.path);
    if (e.link) return `L ${e.path} ${readlinkSync(full)}`;
    bytes += e.size;
    return `F ${e.path} ${e.exec ? 1 : 0} ${e.size} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
  });
  return { sha256: createHash('sha256').update(records.join('\n')).digest('hex'), files: records.length, bytes };
}

export interface Component { id: string; version: string; payload: string; entrypoints: Record<string, string> }

/** The real path, or null when it does not resolve. */
function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** `file` exists and, links resolved, stays under `root` (a real path). */
function inside(file: string, root: string): boolean {
  const path = real(file);
  return path !== null && path.startsWith(root + sep);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * `bundle` (`Contents/Resources/components`) holds `<id>/`, `support` holds `<id>/<version>-<sha8>/`; each has
 * `component.json` and `payload/`. `host` and `renderer` have only `component.json`: their files sit in `Contents` (on
 * Windows the portable directory) where `placed` says, and their `payload` is `Contents`. Throws when the lock or `host` is unusable; any other component that
 * does not resolve, or requires one that does not, is left out of `components` and listed in `failures`.
 */
export function resolveComponents(lockPath: string, bundle: string, support: string, platform: ComponentPlatform):
  { components: Component[]; failures: ComponentFailure[] } {
  const text = readText(lockPath);
  if (text === null) throw new ComponentFailure(null, 'lockInvalid');
  return resolveLock(parseLock(text, platform), bundle, support, platform);
}

function resolveLock(lock: Lock, bundle: string, support: string, platform: ComponentPlatform, verified?: Map<string, Manifest>) {
  const contents = dirname(dirname(bundle));
  const load = (entry: LockEntry): { manifest: Manifest; component: Component } => {
    const fixed = entry.id === 'host' || entry.id === 'renderer';
    const dir = entry.placement === 'bundle' ? join(bundle, entry.id) : join(support, entry.id, `${entry.version}-${entry.sha256.slice(0, 8)}`);
    const payload = fixed ? contents : join(dir, 'payload');
    const manifest = verified ? verified.get(entry.id) : manifestAt(join(dir, 'component.json'), entry.id, platform);
    if (!manifest || !(fixed || (existsSync(payload) && statSync(payload).isDirectory()))) {
      throw new ComponentFailure(entry.id, 'componentMissing');
    }
    if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.sha256 !== entry.sha256
      || manifest.platform !== lock.platform) throw new ComponentFailure(entry.id, 'manifestMismatch');
    const root = real(payload);
    if (root === null) throw new ComponentFailure(entry.id, 'componentMissing');
    for (const target of Object.values(manifest.placed)) {
      if (!inside(join(contents, target), root)) throw new ComponentFailure(entry.id, 'componentMissing');
    }
    const entrypoints: Record<string, string> = {};
    for (const [name, path] of Object.entries(manifest.entrypoints)) {
      let file = join(payload, path);
      if (fixed) {
        const place = Object.entries(manifest.placed).find(([source]) => path === source || path.startsWith(source + '/'));
        if (place === undefined) throw new ComponentFailure(entry.id, 'entrypointMissing');
        file = join(contents, place[1] + path.slice(place[0].length));
      }
      if (!inside(file, root)) throw new ComponentFailure(entry.id, 'entrypointMissing');
      entrypoints[name] = file;
    }
    return { manifest, component: { id: entry.id, version: entry.version, payload, entrypoints } };
  };
  const loaded: { manifest: Manifest; component: Component }[] = [], failures: ComponentFailure[] = [];
  for (const entry of [lock.host, ...lock.components]) {
    try {
      loaded.push(load(entry));
    } catch (e) {
      if (!(e instanceof ComponentFailure) || entry.id === lock.host.id) throw e;
      failures.push(e);
    }
  }
  const met = dropUnmet(lock, loaded.map((l) => l.manifest), failures);
  const kept = new Set(met.kept.map((m) => m.id));
  return { components: loaded.filter((l) => kept.has(l.manifest.id)).map((l) => l.component), failures: met.failures };
}

function manifestAt(path: string, id: string, platform: ComponentPlatform): Manifest {
  const data = readText(path);
  if (data === null) throw new ComponentFailure(id, 'componentMissing');
  const manifest = parseManifest(data, platform);
  if (manifest === null) throw new ComponentFailure(id, 'manifestInvalid');
  if (manifest.id !== id) throw new ComponentFailure(id, 'manifestMismatch');
  return manifest;
}

export function writeAtomic(path: string, text: string, mode?: number): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  renameSync(temp, path);
}

/**
 * Installs a split app's external components from `source` (the `components/` beside the app) into
 * `<support>/components/` and writes the split lock there. Each new copy is checked in full before it is renamed into
 * place. Every launch checks installed copies against the index sealed in the app.
 */
export function installComponents(source: string, bundle: string, support: string, platform: ComponentPlatform) {
  const components = join(support, 'components');
  const host = manifestAt(join(bundle, 'host/component.json'), 'host', platform);
  const signed = readFileSync(join(dirname(bundle), 'components-index.json'));
  const index = join(source, 'index.json');
  const hasSource = existsSync(index);
  if (hasSource && !signed.equals(readFileSync(index))) throw new ImportFailure(null, 'indexInvalid');
  const entries = parseIndex(signed.toString('utf8'));
  const failed: Record<string, string> = {};
  const verified = new Map([[host.id, host]]);
  for (const id of BUNDLED.slice(1)) {
    try {
      verified.set(id, manifestAt(join(bundle, id, 'component.json'), id, platform));
    } catch (e) {
      failed[id] = e instanceof ComponentFailure ? e.reason : 'ioError';
    }
  }
  for (const entry of entries) {
    const target = join(components, entry.id, `${entry.version}-${entry.sha256.slice(0, 8)}`);
    const copy = !existsSync(target);
    let dir = target;
    try {
      if (copy) {
        if (!hasSource) throw new ComponentFailure(entry.id, 'componentMissing');
        const from = join(source, entry.dir);
        // Types without following links: a copied link would keep pointing outside the installed tree.
        const type = (name: string) => { try { return lstatSync(join(from, name)); } catch { return null; } };
        if (!type('component.json')?.isFile() || !type('payload')?.isDirectory()) throw new ComponentFailure(entry.id, 'componentMissing');
        dir = join(components, `.staging-${randomUUID()}`);
        mkdirSync(dir, { recursive: true });
        for (const name of ['component.json', 'payload']) {
          cpSync(join(from, name), join(dir, name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
        }
      }
      const data = readFileSync(join(dir, 'component.json'));
      if (createHash('sha256').update(data).digest('hex') !== entry.manifestSHA256) throw new ComponentFailure(entry.id, 'manifestMismatch');
      const manifest = parseManifest(data.toString('utf8'), platform);
      if (manifest === null) throw new ComponentFailure(entry.id, 'manifestInvalid');
      if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.sha256 !== entry.sha256) throw new ComponentFailure(entry.id, 'manifestMismatch');
      const payload = join(dir, 'payload');
      const tree = treeHash(payload, entry.id);
      if (tree.sha256 !== manifest.sha256 || tree.files !== manifest.files || tree.bytes !== manifest.bytes) {
        throw new ImportFailure(entry.id, 'treeMismatch');
      }
      const root = real(payload);
      for (const path of Object.values(manifest.entrypoints)) {
        if (root === null || !inside(join(payload, path), root)) throw new ComponentFailure(entry.id, 'entrypointMissing');
      }
      if (copy) {
        mkdirSync(dirname(target), { recursive: true });
        renameSync(dir, target);
        dir = target;
      }
      verified.set(entry.id, manifest);
    } catch (e) {
      failed[entry.id] = e instanceof ComponentFailure || e instanceof ImportFailure ? e.reason : 'ioError';
    } finally {
      if (dir !== target) rmSync(dir, { recursive: true, force: true });
    }
  }
  const lock = {
    schema: 'endfield-composition/v1', edition: 'split', platform,
    created_at: new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
    host: { id: host.id, version: host.version, tree_sha256: host.sha256 },
    components: [
      ...BUNDLED.slice(1).filter((id) => verified.has(id)).map((id) => {
        const m = verified.get(id)!;
        return { id, version: m.version, tree_sha256: m.sha256, placement: 'bundle' };
      }),
      ...entries.map((e) => ({ id: e.id, version: e.version, tree_sha256: e.sha256, placement: 'support' })),
    ],
  };
  mkdirSync(components, { recursive: true });
  const text = JSON.stringify(lock, null, 2);
  writeAtomic(join(components, 'composition.lock.json'), text);
  return { lock: parseLock(text, platform), verified, failed };
}

/** What the lock resolved to; a path is null when its component is in `missing`. */
export interface Composition {
  agentd: string | null; python: string | null; renderer: string | null; webUI: string | null; launcher: string | null;
  /** `harness.pi` → its payload directory. */
  harnessSites: Record<string, string>;
  /** Components other than host that did not resolve → why. */
  missing: Record<string, Reason>;
  /** The payloads of the `characters.` components, in lock order: what the seed library is composed of. */
  characters: string[];
}

/**
 * A packaged launch's components. A split app verifies its support components before resolving them. Throws ConfigError when the lock or the host is unusable or the import fails;
 * nothing starts then.
 */
export function prepareComponents(options: { resources: string; support: string; layout: 'portable' | 'split'; platform: ShellPlatform }):
  Composition {
  const { resources, support } = options, platform = componentPlatform(options.platform);
  // The split layout's `components/` beside the app is a macOS bundle's; a Windows package is portable only.
  if (options.layout === 'split' && options.platform === 'windows') throw new ConfigError('无效的发行配置');
  const bundle = join(resources, 'components');
  mkdirSync(support, { recursive: true, mode: 0o700 });
  let resolved: { components: Component[]; failures: ComponentFailure[] };
  try {
    if (options.layout === 'split') {
      const source = join(resources, '../../../components');
      let imported;
      try {
        imported = installComponents(source, bundle, support, platform);
      } catch (e) {
        throw new ConfigError(`组件导入失败：${e instanceof Error ? e.message : String(e)}`);
      }
      for (const [id, reason] of Object.entries(imported.failed)) appendLog(support, 'supervisor', `component import failed: ${id} ${reason}`);
      resolved = resolveLock(imported.lock, bundle, join(support, 'components'), platform, imported.verified);
    } else {
      resolved = resolveComponents(join(resources, 'composition.lock.json'), bundle, join(support, 'components'), platform);
    }
  } catch (e) {
    if (!(e instanceof ComponentFailure)) throw e;
    throw new ConfigError(`组件无法使用：${e.component ?? 'composition.lock.json'} ${e.reason}`);
  }
  const missing: Record<string, Reason> = {};
  for (const f of resolved.failures) if (f.component !== null) missing[f.component] = f.reason;
  const url = (id: string, pick: (c: Component) => string | undefined): string | null => {
    if (Object.hasOwn(missing, id)) return null;
    const component = resolved.components.find((c) => c.id === id);
    if (component === undefined) {
      missing[id] = 'componentMissing';
      return null;
    }
    const value = pick(component);
    if (value === undefined) {
      missing[id] = 'entrypointMissing';
      return null;
    }
    return value;
  };
  const agentd = url('agentd', (c) => (existsSync(join(c.payload, 'agentd')) ? join(c.payload, 'agentd') : undefined));
  const launcher = url('agentd', (c) => c.entrypoints.launcher), python = url('runtime.python', (c) => c.entrypoints.python);
  const renderer = url('renderer', (c) => c.entrypoints.executable), webUI = url('web-ui', (c) => c.payload);
  return {
    agentd: Object.hasOwn(missing, 'agentd') ? null : agentd, python, renderer, webUI, launcher,
    // agentd exits 2 on any other --harness-site ID (C9).
    harnessSites: Object.fromEntries(resolved.components.filter((c) => c.id === 'harness.pi').map((c) => [c.id, c.payload])),
    missing, characters: resolved.components.filter((c) => c.id.startsWith('characters.')).map((c) => c.payload),
  };
}

/** Sets the composition's paths and `missing_components` on a config.json object, keeping its other keys. */
export function setComposition(c: Record<string, unknown>, composition: Composition): void {
  // A missing component's paths are empty: `missing_components` keeps its child from starting.
  c.avatar_executable = composition.renderer ?? '';
  c.agentd_dir = composition.agentd ?? '';
  c.python = composition.python ?? '';
  c.agentd_launcher = composition.launcher ?? '';
  c.harness_sites = composition.harnessSites;
  if (Object.keys(composition.missing).length > 0) c.missing_components = composition.missing;
  else delete c.missing_components;
}

/** Writes the composition's paths and `missing_components` into config.json, keeping its other keys. */
export function writeComposition(configPath: string, composition: Composition): void {
  const original = readText(configPath);
  const config: unknown = original === null ? {} : JSON.parse(original);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new ConfigError('发行配置不是对象');
  const c = config as Record<string, unknown>;
  setComposition(c, composition);
  const text = JSON.stringify(c, null, 2);
  if (text !== original) writeAtomic(configPath, text, 0o600);
}
