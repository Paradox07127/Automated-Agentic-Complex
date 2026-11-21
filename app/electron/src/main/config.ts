// Finds and reads config.json and the character library it names; the decoding is src/common/config.ts.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type Catalog, CatalogError, type Config, ConfigError, parseCatalogDocument, parseCharacterDefinition, parseConfig, parseD3D11Frame,
  type ShellPlatform,
} from '../common/config.ts';
import { defaultDirs, shellPlatform } from './platform/index.ts';

export const DEFAULT_SUPPORT_DIR = defaultDirs().supportDir;
/** Shared with the browser extension's native host. */
export const DEFAULT_AGENTD_STATE_DIR = defaultDirs().agentdStateDir;
export const DEFAULT_WEB_LOGS_DIR = defaultDirs().webLogsDir;

/** The value after `--config`, else the installed app's `<support dir>/config.json`. */
export function configPathFromArgs(argv: readonly string[]): string {
  const i = argv.indexOf('--config');
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : join(DEFAULT_SUPPORT_DIR, 'config.json');
}

/** The seconds after `--quit-after` (1–600) for a test run that quits by itself, else null. */
export function quitAfterFromArgs(argv: readonly string[]): number | null {
  const i = argv.indexOf('--quit-after');
  const seconds = i >= 0 && i + 1 < argv.length && /^\d+$/.test(argv[i + 1]!) ? Number(argv[i + 1]) : NaN;
  return seconds >= 1 && seconds <= 600 ? seconds : null;
}

/**
 * The support dir the config.json at `configPath` runs with, for the instance lock and the runtime config alike: its
 * `support_dir`, also when it does not load; without one, `fallback`.
 */
export function supportDirOf(configPath: string, fallback: string): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).support_dir : undefined;
    if (typeof value === 'string') return value;
  } catch { /* falls back */ }
  return fallback;
}

/** `base`/`file` when it stays under `base`. */
function inside(base: string, file: string): string {
  const path = resolve(base, file);
  if (!path.startsWith(base + sep)) throw new CatalogError('missing_or_escaping_file');
  return path;
}

/**
 * A library's packages as far as the shell needs them: ids, names and whether the renderer has anything to show; on Windows
 * also the character directory efw reads, as agentd's Package walks to it: `current.json` entry → `character.json` →
 * `components.render.native_bundle` → the bundle entry's `d3d11_frame` → the directory holding its `d3d11/`.
 */
export function readCatalog(path: string, platform: ShellPlatform = 'mac'): Catalog | null {
  if (!existsSync(path)) return null;
  const doc = parseCatalogDocument(readFileSync(path, 'utf8'));
  const root = resolve(dirname(path));
  const characters = doc.entries.map((entry) => {
    const file = inside(root, entry.definition);
    if (!existsSync(file)) throw new CatalogError('missing_or_escaping_file');
    const { id, name, renderEnabled, nativeBundle } = parseCharacterDefinition(readFileSync(file, 'utf8'), entry.id);
    if (platform !== 'windows' || !renderEnabled) return { id, name, renderEnabled };
    if (nativeBundle === null) throw new CatalogError('missing_base_component');
    const bundle = inside(dirname(file), nativeBundle);
    if (!existsSync(bundle)) throw new CatalogError('missing_or_escaping_file');
    const frame = parseD3D11Frame(readFileSync(bundle, 'utf8'), id);
    // efw checks the frame table itself (exit 78), so a missing one fails only this character's renderer.
    return { id, name, renderEnabled, d3d11Package: frame === null ? null : dirname(dirname(inside(dirname(file), join(dirname(nativeBundle), frame)))) };
  });
  return { characters, defaultCharacterID: doc.defaultCharacter };
}

export function loadConfig(path: string, platform: ShellPlatform = shellPlatform()): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`找不到配置文件 ${path}`);
  }
  try {
    return parseConfig(text, { supportDir: supportDirOf(path, DEFAULT_SUPPORT_DIR), agentdStateDir: DEFAULT_AGENTD_STATE_DIR,
      catalog: (p) => readCatalog(p, platform), platform });
  } catch (e) {
    // A library file that cannot be read.
    if (e instanceof ConfigError) throw e;
    throw new ConfigError('JSON 无效');
  }
}

/** `<support_dir>/state.json`'s `last_character`. */
export function lastCharacter(supportDir: string): string | undefined {
  try {
    const state: unknown = JSON.parse(readFileSync(join(supportDir, 'state.json'), 'utf8'));
    const last = typeof state === 'object' && state !== null ? (state as Record<string, unknown>).last_character : undefined;
    return typeof last === 'string' ? last : undefined;
  } catch {
    return undefined;
  }
}
