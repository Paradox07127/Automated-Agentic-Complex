// C11 composition locks, component manifests and the split import index as the shell reads them, the failure reasons, and what a missing component does
// to the supervised children (docs/components.md §5). Reading files and the tree hash are src/main/components.ts's.
import { type Backoff, type ChildState, crashState } from './agentd.ts';
import type { Config, ShellPlatform } from './config.ts';

/** The values `missing_components` takes, and `lockInvalid` for a lock that cannot be used at all. */
export type Reason = 'lockInvalid' | 'componentMissing' | 'manifestInvalid' | 'manifestMismatch' | 'entrypointMissing'
  | 'requirementUnmet';

export class ComponentFailure extends Error {
  /** null when the lock as a whole is unreadable or malformed. */
  readonly component: string | null;
  readonly reason: Reason;
  /** The interfaces the component's manifest provides; undefined when no manifest of it was read. */
  readonly provides: Record<string, string> | undefined;

  constructor(component: string | null, reason: Reason, provides?: Record<string, string>) {
    super(`${component ?? 'composition.lock.json'} ${reason}`);
    this.component = component;
    this.reason = reason;
    this.provides = provides;
  }
}

/** The import's failures that `Reason` has no value for; they are logged, never written to `missing_components`. */
export class ImportFailure extends Error {
  /** null when `index.json` as a whole is unreadable or malformed. */
  readonly component: string | null;
  readonly reason: 'indexInvalid' | 'treeMismatch';

  constructor(component: string | null, reason: 'indexInvalid' | 'treeMismatch') {
    super(`${component ?? 'index.json'} ${reason}`);
    this.component = component;
    this.reason = reason;
  }
}

export interface LockEntry { id: string; version: string; sha256: string; placement: 'bundle' | 'support' }
export interface Lock { edition: 'portable' | 'split'; platform: string; host: LockEntry; components: LockEntry[] }
export interface Manifest {
  id: string; version: string; sha256: string; platform: string; files: number; bytes: number;
  entrypoints: Record<string, string>; provides: Record<string, string>; requires: Record<string, string>;
  placed: Record<string, string>;
}
export interface IndexEntry { id: string; version: string; sha256: string; manifestSHA256: string; dir: string }

/** C11 `platform`: a lock or manifest for another one than the running OS's does not load. */
export type ComponentPlatform = 'macos-arm64' | 'windows-x64';

export function componentPlatform(os: ShellPlatform): ComponentPlatform {
  return os === 'windows' ? 'windows-x64' : 'macos-arm64';
}

/** The components a split app keeps inside itself; the index may not list them. */
export const BUNDLED = ['host', 'renderer', 'web-ui'];

const whole = (re: RegExp) => (s: unknown): s is string => typeof s === 'string' && re.test(s);
export const isID = whole(/^[a-z][a-z0-9._-]{0,63}$/);
export const isInterface = whole(/^[A-Z][A-Za-z0-9.-]{0,63}$/);
export const isVersion = whole(/^[0-9]+(?:\.[0-9]+)*$/);
export const isSHA256 = whole(/^[0-9a-f]{64}$/);

/** A relative POSIX path without empty, `.` or `..` segments, backslashes or NUL. */
export function isRelative(path: string): boolean {
  return !path.includes('\\') && !path.includes('\0') && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function identity(doc: unknown): { id: string; version: string; sha256: string } | null {
  if (!isObject(doc) || !isID(doc.id) || !isVersion(doc.version) || !isSHA256(doc.tree_sha256)) return null;
  return { id: doc.id, version: doc.version, sha256: doc.tree_sha256 };
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function stringMap(v: unknown): Record<string, string> | null {
  return isObject(v) && Object.values(v).every((x) => typeof x === 'string') ? v as Record<string, string> : null;
}

/** `YYYY-MM-DDTHH:MM:SSZ` naming a real UTC second. */
function isTimestamp(s: unknown): boolean {
  const m = typeof s === 'string' ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(s) : null;
  if (m === null) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h
    && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
}

/** `composition.lock.json` for `platform`; throws `lockInvalid`, naming the entry when one is at fault. */
export function parseLock(text: string, platform: ComponentPlatform): Lock {
  const doc = json(text);
  if (!isObject(doc) || doc.schema !== 'endfield-composition/v1' || (doc.edition !== 'portable' && doc.edition !== 'split')
    || doc.platform !== platform || !isTimestamp(doc.created_at)) {
    throw new ComponentFailure(null, 'lockInvalid');
  }
  const edition = doc.edition;
  const host = identity(doc.host);
  if (host === null) throw new ComponentFailure(isObject(doc.host) && typeof doc.host.id === 'string' ? doc.host.id : null, 'lockInvalid');
  if (!Array.isArray(doc.components)) throw new ComponentFailure(null, 'lockInvalid');
  const ids = new Set([host.id]), components: LockEntry[] = [];
  for (const item of doc.components as unknown[]) {
    const ref = identity(item);
    if (ref === null) throw new ComponentFailure(isObject(item) && typeof item.id === 'string' ? item.id : null, 'lockInvalid');
    const placement = edition === 'portable' || ref.id === 'renderer' || ref.id === 'web-ui' ? 'bundle' : 'support';
    if (ids.has(ref.id) || (item as Obj).placement !== placement) throw new ComponentFailure(ref.id, 'lockInvalid');
    ids.add(ref.id);
    components.push({ ...ref, placement });
  }
  return { edition, platform, host: { ...host, placement: 'bundle' }, components };
}

/** A `component.json` whose fields are all well-formed for `platform`; null otherwise. */
export function parseManifest(text: string, platform: ComponentPlatform): Manifest | null {
  const doc = json(text);
  const id = identity(doc);
  if (id === null || !isObject(doc) || doc.schema !== 'endfield-component/v1' || doc.platform !== platform
    || !count(doc.files) || !count(doc.bytes)) return null;
  const entrypoints = stringMap(doc.entrypoints), provides = stringMap(doc.provides), requires = stringMap(doc.requires);
  if (entrypoints === null || !Object.entries(entrypoints).every(([k, v]) => k !== '' && isRelative(v))) return null;
  if (provides === null || !Object.entries(provides).every(([k, v]) => isInterface(k) && isVersion(v))) return null;
  if (requires === null || !Object.entries(requires).every(([k, v]) => (isInterface(k) || isID(k)) && isVersion(v))) return null;
  let placed: Record<string, string> = {};
  if (doc.placed !== undefined) {
    const map = stringMap(doc.placed);
    if (!['host', 'renderer'].includes(id.id) || map === null
      || !Object.entries(map).every(([k, v]) => isRelative(k) && isRelative(v))) return null;
    placed = map;
  }
  return { ...id, platform, files: doc.files, bytes: doc.bytes, entrypoints, provides, requires, placed };
}

/** The split app's import index `components/index.json`; throws `indexInvalid`, naming the entry when one is at fault. */
export function parseIndex(text: string): IndexEntry[] {
  const doc = json(text);
  if (!isObject(doc) || doc.schema !== 'endfield-components-index/v1' || !Array.isArray(doc.components)) {
    throw new ImportFailure(null, 'indexInvalid');
  }
  const ids = new Set(BUNDLED);
  return (doc.components as unknown[]).map((item) => {
    const o = isObject(item) ? item : {};
    if (!isID(o.id) || !isVersion(o.version) || !isSHA256(o.tree_sha256) || typeof o.dir !== 'string' || !isRelative(o.dir)
      || !isSHA256(o.manifest_sha256) || ids.has(o.id)) {
      throw new ImportFailure(typeof o.id === 'string' ? o.id : null, 'indexInvalid');
    }
    ids.add(o.id);
    return { id: o.id, version: o.version, sha256: o.tree_sha256, manifestSHA256: o.manifest_sha256, dir: o.dir };
  });
}

/**
 * Over the manifests that loaded, drops each one whose component or interface requirements the rest do not meet, as
 * `requirementUnmet`, until none drops. The host runs without an interface when a failed component provides it, or
 * might (no manifest of it was read); throws when the host itself is unmet.
 */
export function dropUnmet(lock: Lock, loaded: Manifest[], failures: ComponentFailure[]): { kept: Manifest[]; failures: ComponentFailure[] } {
  let kept = loaded;
  const failed = [...failures];
  for (;;) {
    const versions = new Map(kept.map((m) => [m.id, m.version]));
    const provided = new Set(kept.flatMap((m) => Object.entries(m.provides).map(([k, v]) => `${k}\0${v}`)));
    const interfaces = new Set(kept.flatMap((m) => Object.keys(m.provides)));
    const met = (m: Manifest, name: string, version: string) => {
      if (isInterface(name) ? provided.has(`${name}\0${version}`) : versions.get(name) === version) return true;
      if (m.id !== lock.host.id) return false;
      if (isInterface(name)) return !interfaces.has(name) && failed.some((f) => f.provides === undefined || Object.hasOwn(f.provides, name));
      return lock.components.some((c) => c.id === name && c.version === version) && failed.some((f) => f.component === name);
    };
    const unmet = new Set(kept.filter((m) => !Object.entries(m.requires).every(([k, v]) => met(m, k, v))).map((m) => m.id));
    if (unmet.size === 0) return { kept, failures: failed };
    if (unmet.has(lock.host.id)) throw new ComponentFailure(lock.host.id, 'requirementUnmet');
    for (const m of kept) if (unmet.has(m.id)) failed.push(new ComponentFailure(m.id, 'requirementUnmet', m.provides));
    kept = kept.filter((m) => !unmet.has(m.id));
  }
}

/** Why the renderer does not start with this config; null when it may. */
export function rendererPreflight(config: Config): ChildState | null {
  if (Object.hasOwn(config.missingComponents, 'renderer')) return { kind: 'failed', reason: '缺 renderer 组件' };
  if (config.characterLibraryMissing.length > 0) {
    return { kind: 'failed', reason: `没有角色库：缺 ${config.characterLibraryMissing.join(' ')} 组件` };
  }
  return null;
}

/** The renderer's state after it exits: 78 (package and program differ), 69 (no usable Metal device) and 71 (Vulkan cannot run)
 * fail without a restart. */
export function rendererExit(status: number | null, signal: string | null, backoff: Backoff): ChildState {
  if (signal === null && status === 78) return { kind: 'failed', reason: '角色包与程序版本不符' };
  if (signal === null && (status === 69 || status === 71)) return { kind: 'failed', reason: '无法使用 GPU' };
  return crashState(backoff.recordCrash());
}
