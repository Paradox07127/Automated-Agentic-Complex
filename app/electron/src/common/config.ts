// config.json decoded: the keys the main process uses, with their defaults and error texts. Reading files is the caller's: `src/main/config.ts`.
import { DEFAULT_PLUGINS, isPluginId, type Plugins } from './plugins.ts';
import { canonicalProxyUrl, unsafeSshHost, validProxyUrl } from './settings.ts';

/** Paths under the home directory. */
export const IDS = {
  /** The bundle id, and on Windows the AppUserModelID. */
  appId: 'local.agenticcomplex.companion',
  companionSupportDir: 'Library/Application Support/local.agenticcomplex.companion',
  agentdStateDir: 'Library/Application Support/AgenticComplex/agentd',
  webLogsDir: 'Library/Logs/AgenticComplex',
} as const;

/** The external services config.json's `services` connects. */
export const SERVICE_IDS = ['tts', 'motion', 'llm'] as const;
export type ServiceId = typeof SERVICE_IDS[number];
export const SERVICE_MODES = ['off', 'url', 'ssh', 'local'] as const;
export type ServiceMode = typeof SERVICE_MODES[number];

/** One entry of `services`, as config.json keeps it. */
export interface ServiceRecord {
  mode: ServiceMode;
  url: string;
  ssh_host: string;
  /** Run over ssh on `ssh_host` with `ensure`, `stop` or `status`; only under `ssh`. */
  start_script: string;
  /** argv run on this machine under `local`. */
  command: string[];
  /** `command`'s working directory; empty leaves it unset. */
  cwd: string;
}

const service = (url: string): ServiceRecord => ({ mode: 'off', url, ssh_host: '', start_script: '', command: [], cwd: '' });
export const SERVICE_DEFAULTS: Readonly<Record<ServiceId, ServiceRecord>> = {
  tts: service('http://127.0.0.1:9888'),
  motion: service('http://127.0.0.1:48830'),
  llm: service('http://127.0.0.1:11434/v1'),
};

export const isServiceId = (v: unknown): v is ServiceId => SERVICE_IDS.includes(v as ServiceId);

/** The port written in `url`; null when there is none or it does not parse. */
export function servicePort(url: string): number | null {
  const port = URL.parse(url)?.port ?? '';
  return port === '' ? null : Number(port);
}

/** Whether `url` names this machine. */
export function loopbackURL(url: string): boolean {
  const host = URL.parse(url)?.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/** A `services` record that does not hold: `field` is the record key at fault, `message` the text shown. */
export class ServiceRecordError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** `v` as a record of service `id`; an absent field is its default. Throws `ServiceRecordError`. */
export function serviceRecord(id: ServiceId, v: unknown): ServiceRecord {
  if (!isObject(v)) throw new ServiceRecordError('', `服务 ${id} 不是对象`);
  const unknown = Object.keys(v).find((k) => !Object.hasOwn(SERVICE_DEFAULTS[id], k));
  if (unknown !== undefined) throw new ServiceRecordError(unknown, `服务 ${id} 没有字段 ${unknown}`);
  const field = <T>(key: keyof ServiceRecord, ok: (x: unknown) => x is T): T => {
    if (!Object.hasOwn(v, key)) return SERVICE_DEFAULTS[id][key] as T;
    if (!ok(v[key])) throw new ServiceRecordError(key, `服务 ${id} 的 ${key} 类型错误`);
    return v[key];
  };
  const isString = (x: unknown): x is string => typeof x === 'string';
  const r: ServiceRecord = {
    mode: field('mode', (x): x is ServiceMode => SERVICE_MODES.includes(x as ServiceMode)),
    url: field('url', isString), ssh_host: field('ssh_host', isString), start_script: field('start_script', isString),
    command: field('command', (x): x is string[] => Array.isArray(x) && x.every(isString)), cwd: field('cwd', isString),
  };
  if (r.mode === 'off') return r;
  const url = URL.parse(r.url);
  // As agentd's parse_args: it exits at each start on an address it refuses. URL.parse drops the blanks r.url would keep.
  if (url === null || !['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== ''
    || url.hash !== '' || r.url !== r.url.trim()) {
    throw new ServiceRecordError('url', `服务 ${id} 的地址无效`);
  }
  // agentd refuses --llm-url over http to another host (the API key would travel in the clear) and would exit at each start.
  if (id === 'llm' && url.protocol === 'http:' && !loopbackURL(r.url)) throw new ServiceRecordError('url', `服务 ${id} 的地址要用 https://（本机可用 http）`);
  if (r.mode === 'url') return r;
  if (!loopbackURL(r.url) || servicePort(r.url) === null) throw new ServiceRecordError('url', `服务 ${id} 的地址要是本机地址并写端口`);
  if (r.mode === 'ssh' && (r.ssh_host === '' || unsafeSshHost(r.ssh_host))) {
    throw new ServiceRecordError('ssh_host', `服务 ${id} 的 SSH 主机无效：不能为空、不能以 - 开头，不能有空白或控制字符`);
  }
  if (r.mode === 'local' && (r.command.length === 0 || r.command[0] === '')) throw new ServiceRecordError('command', `服务 ${id} 没有命令`);
  return r;
}

const services: Check<Record<ServiceId, ServiceRecord>> = (v, path) => {
  if (!isObject(v)) throw typeError(path);
  const unknown = Object.keys(v).find((id) => !isServiceId(id));
  if (unknown !== undefined) throw new ConfigError(`未知服务 ${unknown}`);
  return Object.fromEntries(SERVICE_IDS.map((id) => {
    if (!Object.hasOwn(v, id)) return [id, SERVICE_DEFAULTS[id]];
    try {
      return [id, serviceRecord(id, v[id])];
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
  })) as Record<ServiceId, ServiceRecord>;
};

/** The platform a caller passes in. */
export type ShellPlatform = 'mac' | 'windows';

export class ConfigError extends Error {
  /** The config.json key whose file is gone, and the path it names. */
  readonly missingKey?: string;
  readonly missingPath?: string;

  constructor(message: string, missing?: { key: string; path: string }) {
    super(message);
    this.missingKey = missing?.key;
    this.missingPath = missing?.path;
  }
}

/** A character library that does not validate; `reason` is CharacterAssets' code, e.g. `unsupported_catalog_schema`. */
export class CatalogError extends Error {}

/** The companion.log line for a launch config that failed. */
export function configLogLine(error: unknown): string {
  if (error instanceof ConfigError && error.missingKey !== undefined && error.missingPath !== undefined) {
    return `ERROR config ${error.missingKey} missing: ${error.missingPath}`;
  }
  return `ERROR config ${error instanceof Error ? error.message : String(error)}`;
}

export interface AvatarCharacter {
  id: string;
  name: string;
  avatarApp: string;
  avatarArgs: string[];
  /** false for a text-only package; absent for a `characters` entry, which always has a player. */
  renderEnabled?: boolean;
}

/** What the main process read from a character library's `current.json` and its packages' `character.json`. */
export interface Catalog {
  /** `vulkanPackage`: read only for Windows, the character directory of a bundle entry with `vulkan_frame`, else null. */
  characters: { id: string; name: string; renderEnabled: boolean; vulkanPackage?: string | null }[];
  /** null only for a library without characters. */
  defaultCharacterID: string | null;
}

export interface ConfigContext {
  supportDir: string;
  agentdStateDir: string;
  /** Reads the library at `path`; null when the file does not exist. Throws `CatalogError` when it does not validate. */
  catalog(path: string): Catalog | null;
  /** Absent is macOS. */
  platform?: ShellPlatform;
}

export interface Config {
  characters: AvatarCharacter[];
  characterCatalog: string | null;
  /** Id of the selected entry in `characters`; empty when a catalog has no characters. */
  character: string;
  avatarApp: string;
  avatarExecutable: string | null;
  agentdDir: string;
  python: string;
  /** The agentd component's `launcher` entrypoint; null without a composition lock. */
  agentdLauncher: string | null;
  harnessSites: Record<string, string>;
  missingComponents: Record<string, string>;
  characterLibraryMissing: string[];
  agentdPort: number;
  gpuHoldFiles: string[];
  supportDir: string;
  interactionPreset: string;
  /** `plugins`, each id it leaves out at the registry's default. */
  plugins: Plugins;
  sharePageText: boolean;
  shareWindowText: boolean;
  shareTypedText: boolean;
  shareActions: boolean;
  shareAgentSessions: boolean;
  shareScreenshots: boolean;
  redactSensitive: boolean;
  proactiveSpeech: boolean;
  /** agentd's HTTP(S) proxy (agentd.ts agentdEnv); '' leaves the inherited environment. */
  proxyUrl: string;
  mute: boolean;
  agentdStateDir: string;
  /** `services`, each id it leaves out at its default. */
  services: Record<ServiceId, ServiceRecord>;
  devResources: string | null;
}

type Check<T> = (v: unknown, path: string) => T;
type JsonObject = Record<string, unknown>;

const typeError = (path: string) => new ConfigError(`字段 ${path} 类型错误`);
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

const str: Check<string> = (v, path) => { if (typeof v !== 'string') throw typeError(path); return v; };
const bool: Check<boolean> = (v, path) => { if (typeof v !== 'boolean') throw typeError(path); return v; };
const int: Check<number> = (v, path) => { if (typeof v !== 'number' || !Number.isInteger(v)) throw typeError(path); return v; };
const strings: Check<string[]> = (v, path) => {
  if (!Array.isArray(v)) throw typeError(path);
  return v.map((x, i) => str(x, `${path}.Index ${i}`));
};
const stringMap: Check<Record<string, string>> = (v, path) => {
  if (!isObject(v)) throw typeError(path);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x, `${path}.${k}`)]));
};
const plugins: Check<Plugins> = (v, path) => {
  if (!isObject(v)) throw typeError(path);
  const unknown = Object.keys(v).find((id) => !isPluginId(id));
  if (unknown !== undefined) throw new ConfigError(`未知插件 ${unknown}`);
  return { ...DEFAULT_PLUGINS, ...Object.fromEntries(Object.entries(v).map(([id, on]) => [id, bool(on, `${path}.${id}`)])) };
};

/** Absent is 缺少字段, null or another type is 类型错误. */
function required<T>(o: JsonObject, key: string, check: Check<T>, path = key): T {
  if (!Object.hasOwn(o, key)) throw new ConfigError(`缺少字段 ${key}`);
  return check(o[key], path);
}

/** Absent or null is undefined, another type is 类型错误. */
function optional<T>(o: JsonObject, key: string, check: Check<T>, path = key): T | undefined {
  if (!Object.hasOwn(o, key) || o[key] === null) return undefined;
  return check(o[key], path);
}

function avatarCharacter(v: unknown, path: string): AvatarCharacter {
  if (!isObject(v)) throw typeError(path);
  return {
    id: required(v, 'id', str, `${path}.id`),
    name: required(v, 'name', str, `${path}.name`),
    avatarApp: required(v, 'avatar_app', str, `${path}.avatar_app`),
    avatarArgs: optional(v, 'avatar_args', strings, `${path}.avatar_args`) ?? [],
  };
}

const oneOf = (value: string, allowed: string[], fallback: string) => (allowed.includes(value) ? value : fallback);

/** Decodes config.json text; throws `ConfigError`. */
export function parseConfig(text: string, ctx: ConfigContext): Config {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new ConfigError('JSON 无效');
  }
  if (!isObject(o)) throw typeError('');
  let characterCatalog = optional(o, 'character_catalog', str) ?? null;
  let characters: AvatarCharacter[];
  const list = optional(o, 'characters', (v, path) => {
    if (!Array.isArray(v)) throw typeError(path);
    return v.map((x, i) => avatarCharacter(x, `${path}.Index ${i}`));
  });
  if (list !== undefined) {
    characters = list;
  } else if (characterCatalog === null) {
    throw new ConfigError('缺少字段 characters');
  } else {
    characters = [];
  }
  let catalogDefault: string | null = null;
  if (characterCatalog !== null) {
    let loaded: Catalog | null;
    try {
      loaded = ctx.catalog(characterCatalog);
    } catch (e) {
      if (e instanceof CatalogError) throw new ConfigError(`角色目录无效：${e.message}`);
      throw e;
    }
    if (loaded === null) {
      throw new ConfigError(`角色目录不存在：${characterCatalog}`, { key: 'character_catalog', path: characterCatalog });
    }
    // On Windows, efw takes the character directory, and draws only a character whose bundle entry has `vulkan_frame`;
    // `--package-of` names every such character's directory, for set_character.
    const catalogPath = characterCatalog;
    const packageOf = loaded.characters.flatMap((c) => (c.renderEnabled && c.vulkanPackage ? ['--package-of', `${c.id}=${c.vulkanPackage}`] : []));
    const launches = loaded.characters.map((c) => (ctx.platform !== 'windows'
      ? { args: ['--character-catalog', catalogPath], renderEnabled: c.renderEnabled }
      : { args: c.vulkanPackage ? ['--package', c.vulkanPackage, ...packageOf] : [], renderEnabled: c.renderEnabled && !!c.vulkanPackage }));
    // Text-only characters start no renderer, so a library of only them needs no host.
    const host = optional(o, 'avatar_app', str) ?? characters[0]?.avatarApp;
    if (host === undefined && launches.some((l) => l.renderEnabled)) throw new ConfigError('角色目录需要 avatar_app');
    characters = loaded.characters.map((c, i) => ({ id: c.id, name: c.name, avatarApp: host ?? '',
      avatarArgs: launches[i]!.args, renderEnabled: launches[i]!.renderEnabled }));
    catalogDefault = loaded.defaultCharacterID;
  }
  let character: string, avatarApp: string;
  if (characters.length === 0 && characterCatalog !== null) {
    // A library without characters: no avatar starts until a character package is imported.
    character = '';
    avatarApp = optional(o, 'avatar_app', str) ?? '';
  } else {
    const first = characters[0];
    if (first === undefined) throw new ConfigError('characters 为空');
    character = optional(o, 'character', str) ?? catalogDefault ?? first.id;
    const chosen = characters.find((c) => c.id === character);
    if (chosen === undefined) throw new ConfigError(`角色 ${character} 不在 characters 里`);
    avatarApp = chosen.avatarApp;
  }
  const avatarExecutable = optional(o, 'avatar_executable', str) ?? null;
  const agentdDir = required(o, 'agentd_dir', str);
  const python = required(o, 'python', str);
  const agentdLauncher = optional(o, 'agentd_launcher', str) ?? null;
  const harnessSites = optional(o, 'harness_sites', stringMap) ?? {};
  const missingComponents = optional(o, 'missing_components', stringMap) ?? {};
  // A character_catalog that loaded is a library, also one the user set after the launch that wrote character_library_missing.
  const characterLibraryMissing = characterCatalog === null ? optional(o, 'character_library_missing', strings) ?? [] : [];
  const agentdPort = required(o, 'agentd_port', int);
  const gpuHoldFiles = required(o, 'gpu_hold_files', strings);
  const supportDir = optional(o, 'support_dir', str) ?? ctx.supportDir;
  const live = agentdLive(o);
  const interactionPreset = live.interaction_preset;
  const pluginsOn = optional(o, 'plugins', plugins) ?? DEFAULT_PLUGINS;
  const sharePageText = live.share_page_text;
  const shareWindowText = live.share_window_text;
  const shareTypedText = live.share_typed_text;
  const shareActions = optional(o, 'share_actions', bool) ?? false;
  const shareAgentSessions = live.share_agent_sessions;
  const shareScreenshots = live.share_screenshots;
  const redactSensitive = live.redact_sensitive;
  const proactiveSpeech = live.proactive_speech;
  const proxy = optional(o, 'proxy_url', str) ?? '';
  const proxyUrl = validProxyUrl(proxy) ? canonicalProxyUrl(proxy) : '';
  const mute = live.mute;
  const agentdStateDir = optional(o, 'agentd_state_dir', str) ?? ctx.agentdStateDir;
  const servicesOn = optional(o, 'services', services) ?? SERVICE_DEFAULTS;
  const devResources = optional(o, 'dev_resources', str) ?? null;
  return {
    characters, characterCatalog, character, avatarApp, avatarExecutable, agentdDir, python, agentdLauncher, harnessSites,
    missingComponents, characterLibraryMissing, agentdPort, gpuHoldFiles, supportDir, interactionPreset, plugins: pluginsOn,
    sharePageText, shareWindowText, shareTypedText, shareActions, shareAgentSessions, shareScreenshots, redactSensitive, proactiveSpeech,
    proxyUrl, mute, agentdStateDir, services: servicesOn, devResources,
  };
}

/** The agentd settings it launches with (agentd.ts agentdArguments) and takes live (`PUT /settings/live`), from config.json's
 *  top level; throws ConfigError on a wrong type. */
export function agentdLive(o: JsonObject) {
  return {
    mute: optional(o, 'mute', bool) ?? false,
    proactive_speech: optional(o, 'proactive_speech', bool) ?? true,
    interaction_preset: oneOf(optional(o, 'interaction_preset', str) ?? 'balanced', ['quiet', 'balanced', 'active'], 'balanced'),
    redact_sensitive: optional(o, 'redact_sensitive', bool) ?? true,
    share_page_text: optional(o, 'share_page_text', bool) ?? false,
    share_window_text: optional(o, 'share_window_text', bool) ?? false,
    share_typed_text: optional(o, 'share_typed_text', bool) ?? false,
    share_agent_sessions: optional(o, 'share_agent_sessions', bool) ?? true,
    share_screenshots: optional(o, 'share_screenshots', bool) ?? false,
  };
}

/** The first of `ids` in `missing_components`; the default is what running agentd's Python scripts needs. */
export function firstMissingComponent(config: Config, ids = ['agentd', 'runtime.python']): string | undefined {
  return ids.find((id) => Object.hasOwn(config.missingComponents, id));
}

/** The agentd the supervisor starts: the dev directory's with `dev_resources`, else `agentd_dir`. */
export function launchAgentdDir(config: Config): string {
  return config.devResources === null ? config.agentdDir : `${config.devResources}/runtime/agentd`;
}

/** Instances on another support dir (the automated tests) must not look like the installed app in the menu bar. */
export function statusTitle(supportDir: string, defaultSupportDir: string): string {
  return supportDir === defaultSupportDir ? 'Agentic Complex' : 'Agentic Complex·测试';
}

/** The directory of the web pages' `ui.log`: the installed app's under ~/Library/Logs, any other support dir's `logs`. */
export function webLogsDir(supportDir: string, defaultSupportDir: string, defaultWebLogsDir: string): string {
  return supportDir === defaultSupportDir ? defaultWebLogsDir : `${supportDir}/logs`;
}

/** `state.json`'s `last_character` when the library still has it, else the configured character. */
export function launchCharacter(config: Config, last: string | undefined): string {
  return last !== undefined && config.characters.some((c) => c.id === last) ? last : config.character;
}

/** `current.json` of a character library (schema `endfield-character-library/v1`): entry ids, definition files, default. */
export function parseCatalogDocument(text: string): { entries: { id: string; definition: string }[]; defaultCharacter: string | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ConfigError('JSON 无效');
  }
  if (!isObject(doc) || doc.schema !== 'endfield-character-library/v1') throw new CatalogError('unsupported_catalog_schema');
  if (!Array.isArray(doc.characters)) throw new CatalogError('unsupported_catalog_schema');
  const entries = doc.characters.map((e) => {
    if (!isObject(e) || typeof e.id !== 'string' || !isObject(e.definition) || typeof e.definition.file !== 'string') {
      throw new CatalogError('catalog_character_identity_mismatch');
    }
    return { id: e.id, definition: e.definition.file };
  });
  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) throw new CatalogError('catalog_character_identity_mismatch');
  const defaultCharacter = typeof doc.default_character === 'string' ? doc.default_character : (entries[0]?.id ?? null);
  if (defaultCharacter !== null && !ids.has(defaultCharacter)) throw new CatalogError('unknown_default_character');
  return { entries, defaultCharacter };
}

/**
 * A package's `character.json`: its id must be the library entry's; the name is `display.name` zh-Hans, else the first;
 * `nativeBundle` is `components.render.native_bundle.file` (relative to the package), null when it has none.
 */
export function parseCharacterDefinition(text: string, entryID: string):
  { id: string; name: string; renderEnabled: boolean; nativeBundle: string | null } {
  let def: unknown;
  try {
    def = JSON.parse(text);
  } catch {
    throw new ConfigError('JSON 无效');
  }
  if (!isObject(def) || def.id !== entryID) throw new CatalogError('catalog_character_identity_mismatch');
  const names = isObject(def.display) && isObject(def.display.name) ? def.display.name : {};
  const zh = names['zh-Hans'];
  const first = Object.keys(names).sort()[0];
  const name = typeof zh === 'string' ? zh : first !== undefined && typeof names[first] === 'string' ? names[first] : entryID;
  const components = isObject(def.components) ? def.components : {};
  const bundle = isObject(components.render) && isObject(components.render.native_bundle) ? components.render.native_bundle.file : undefined;
  return { id: entryID, name, renderEnabled: components.render !== undefined && components.render !== null,
    nativeBundle: typeof bundle === 'string' ? bundle : null };
}

/** A package's single-character native bundle: its entry's `vulkan_frame` file (relative to the bundle), null without one. */
export function parseVulkanFrame(text: string, entryID: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ConfigError('JSON 无效');
  }
  const entries = isObject(doc) && doc.schema === 'metal-native-character-bundle/v1' && Array.isArray(doc.characters) ? doc.characters : [];
  const entry: unknown = entries.length === 1 ? entries[0] : undefined;
  if (!isObject(entry) || entry.id !== entryID) throw new CatalogError('native_character_identity_mismatch');
  if (entry.vulkan_frame === undefined) return null;
  if (!isObject(entry.vulkan_frame) || typeof entry.vulkan_frame.file !== 'string') throw new CatalogError('invalid_reference');
  return entry.vulkan_frame.file;
}
