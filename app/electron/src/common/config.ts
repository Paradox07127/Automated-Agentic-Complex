// config.json decoded: the keys the main process uses, with their defaults and error texts. Reading files is the caller's: `src/main/config.ts`.
import { DEFAULT_PLUGINS, isPluginId, type Plugins } from './plugins.ts';

/** Paths under the home directory, and the default TTS address. */
export const IDS = {
  companionSupportDir: 'Library/Application Support/local.agenticcomplex.companion',
  agentdStateDir: 'Library/Application Support/AgenticComplex/agentd',
  webLogsDir: 'Library/Logs/AgenticComplex',
  ttsURL: 'http://127.0.0.1:9888',
} as const;

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
  /** `d3d11Package`: read only for Windows, the character directory of a bundle entry with `d3d11_frame`, else null. */
  characters: { id: string; name: string; renderEnabled: boolean; d3d11Package?: string | null }[];
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
  breakReminderMinutes: number;
  /** Active minutes before a water reminder; 0 is off. agentd's own default when config.json has no key. */
  waterReminderMinutes: number;
  mute: boolean;
  agentdStateDir: string;
  ttsURL: string;
  ttsTunnelHost: string;
  ttsEnsureScript: string;
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
    // C3 附录「Windows」: efw takes the character directory, and draws only a character whose bundle entry has `d3d11_frame`;
    // `--package-of` names every such character's directory, for set_character.
    const catalogPath = characterCatalog;
    const packageOf = loaded.characters.flatMap((c) => (c.renderEnabled && c.d3d11Package ? ['--package-of', `${c.id}=${c.d3d11Package}`] : []));
    const launches = loaded.characters.map((c) => (ctx.platform !== 'windows'
      ? { args: ['--character-catalog', catalogPath], renderEnabled: c.renderEnabled }
      : { args: c.d3d11Package ? ['--package', c.d3d11Package, ...packageOf] : [], renderEnabled: c.renderEnabled && !!c.d3d11Package }));
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
  const characterLibraryMissing = optional(o, 'character_library_missing', strings) ?? [];
  const agentdPort = required(o, 'agentd_port', int);
  const gpuHoldFiles = required(o, 'gpu_hold_files', strings);
  const supportDir = optional(o, 'support_dir', str) ?? ctx.supportDir;
  const interactionPreset = oneOf(optional(o, 'interaction_preset', str) ?? 'balanced', ['quiet', 'balanced', 'active'], 'balanced');
  const pluginsOn = optional(o, 'plugins', plugins) ?? DEFAULT_PLUGINS;
  const sharePageText = optional(o, 'share_page_text', bool) ?? false;
  const shareWindowText = optional(o, 'share_window_text', bool) ?? false;
  const shareTypedText = optional(o, 'share_typed_text', bool) ?? false;
  const shareActions = optional(o, 'share_actions', bool) ?? false;
  const shareAgentSessions = optional(o, 'share_agent_sessions', bool) ?? true;
  const shareScreenshots = optional(o, 'share_screenshots', bool) ?? false;
  const redactSensitive = optional(o, 'redact_sensitive', bool) ?? true;
  const proactiveSpeech = optional(o, 'proactive_speech', bool) ?? true;
  const breakReminderMinutes = optional(o, 'break_reminder_minutes', int) ?? 0;
  const waterReminderMinutes = optional(o, 'water_reminder_minutes', int) ?? 90;
  const mute = optional(o, 'mute', bool) ?? false;
  const agentdStateDir = optional(o, 'agentd_state_dir', str) ?? ctx.agentdStateDir;
  let ttsURL = optional(o, 'tts_url', str) ?? IDS.ttsURL;
  let ttsTunnelHost = optional(o, 'tts_tunnel_host', str) ?? '';
  let ttsEnsureScript = optional(o, 'tts_ensure_script', str) ?? '';
  // "remote" keeps a hand-edited tts_url / tts_tunnel_host; without an address it is text only.
  const service = optional(o, 'voice_service', str);
  if (service === 'local' || ttsURL === '') {
    ttsURL = '';
    ttsTunnelHost = '';
    ttsEnsureScript = '';
  }
  const devResources = optional(o, 'dev_resources', str) ?? null;
  return {
    characters, characterCatalog, character, avatarApp, avatarExecutable, agentdDir, python, agentdLauncher, harnessSites,
    missingComponents, characterLibraryMissing, agentdPort, gpuHoldFiles, supportDir, interactionPreset, plugins: pluginsOn,
    sharePageText, shareWindowText, shareTypedText, shareActions, shareAgentSessions, shareScreenshots, redactSensitive, proactiveSpeech,
    breakReminderMinutes, waterReminderMinutes, mute, agentdStateDir, ttsURL, ttsTunnelHost, ttsEnsureScript, devResources,
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

/** A package's single-character native bundle: its entry's `d3d11_frame` file (relative to the bundle), null without one. */
export function parseD3D11Frame(text: string, entryID: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ConfigError('JSON 无效');
  }
  const entries = isObject(doc) && doc.schema === 'metal-native-character-bundle/v1' && Array.isArray(doc.characters) ? doc.characters : [];
  const entry: unknown = entries.length === 1 ? entries[0] : undefined;
  if (!isObject(entry) || entry.id !== entryID) throw new CatalogError('native_character_identity_mismatch');
  if (entry.d3d11_frame === undefined) return null;
  if (!isObject(entry.d3d11_frame) || typeof entry.d3d11_frame.file !== 'string') throw new CatalogError('invalid_reference');
  return entry.d3d11_frame.file;
}
