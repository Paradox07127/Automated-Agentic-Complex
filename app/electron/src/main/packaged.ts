// A launch from the app bundle: the app's `Resources/distribution.json`, its components (components.ts `prepareComponents`), config.json in the support dir and
// the seed character library. An app without distribution.json (Electron from the repo) prepares nothing.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ConfigError, parseConfig, type ShellPlatform } from '../common/config.ts';
import { type Composition, prepareComponents, setComposition, writeAtomic } from './components.ts';
import { readCatalog } from './config.ts';
import { appendLog } from './log.ts';
import { pythonFlags } from './platform/index.ts';

interface Distribution { id: string; layout: 'portable' | 'split'; port: number; catalogSHA256: string; defaultCharacter: string | null }

/** `Resources/distribution.json`; null without one. Throws for one that does not decode or pass the checks. */
function distribution(resources: string): Distribution | null {
  const path = join(resources, 'distribution.json');
  if (!existsSync(path)) return null;
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError('无效的发行配置');
  }
  const o = (typeof m === 'object' && m !== null && !Array.isArray(m) ? m : {}) as Record<string, unknown>;
  const { id, layout, port, catalogSHA256 } = o, defaultCharacter = o.defaultCharacter ?? null;
  if (o.schema !== 'endfield-distribution/v3' || (layout !== 'portable' && layout !== 'split')
    || typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(id)
    || typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535
    || typeof catalogSHA256 !== 'string' || (defaultCharacter !== null && typeof defaultCharacter !== 'string')) {
    throw new ConfigError('无效的发行配置');
  }
  return { id, layout, port, catalogSHA256, defaultCharacter };
}

/** A packaged app's (it has `Resources/distribution.json`) `Contents`, on Windows its portable directory; else null. */
export function packagedContents(resources: string): string | null {
  return existsSync(join(resources, 'distribution.json')) ? dirname(resources) : null;
}

/**
 * The packaged app's `<supportBase>/<id>/config.json`, read only, so the instance lock can be
 * taken before `preparePackaged` writes anything; null without distribution.json.
 */
export function packagedConfigPath(resources: string, supportBase: string): string | null {
  const manifest = distribution(resources);
  return manifest === null ? null : join(supportBase, manifest.id, 'config.json');
}

export interface PackagedPorts {
  /** Runs `file` to its exit, stdin closed: stdout and stderr appended to `log` when given, else stdout dropped and stderr returned. */
  run(file: string, args: string[], log?: string): { status: number | null; stderr: string };
}

export const nodePorts: PackagedPorts = {
  run(file, args, log) {
    const fd = log === undefined ? null : openSync(log, 'a');
    try {
      const r = spawnSync(file, args, { windowsHide: true, stdio: ['ignore', fd ?? 'ignore', fd ?? 'pipe'], encoding: 'utf8' });
      if (r.error) throw r.error;
      return { status: r.status, stderr: r.stderr ?? '' };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  },
};

export interface PackagedLaunch {
  /** `<supportBase>/<id>/config.json`, written with the composition's paths. */
  configPath: string;
  /** Launcher (`launcher`), renderer executable (`renderer`) and the missing components (`missing`) among the rest. */
  composition: Composition;
  /** The web-ui payload's `ui/` (its `art/` inside); null when web-ui is missing. */
  webRoot: string | null;
}

/**
 * The pages' directory. A packaged launch's web root; otherwise (a `--config` launch,
 * the repo) the app's bundled web-ui `ui/` when it has one, else null, for the caller's own default.
 */
export function webRoot(resources: string, launch: PackagedLaunch | null): string | null {
  if (launch !== null) return launch.webRoot;
  return existsSync(join(resources, 'components/web-ui/payload')) ? join(resources, 'components/web-ui/payload/ui') : null;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Removes what an upgrade or import superseded in `library`: package directories, catalog revisions and native bundles its
 * current.json does not name. Only before agentd and the renderer start, when no reader holds an older catalog.
 */
function pruneLibrary(library: string): void {
  const current = JSON.parse(readFileSync(join(library, 'current.json'), 'utf8')) as
    { revision?: string; native_bundle?: { file?: string }; characters: { definition: { file: string } }[] };
  // `packages/<id>/<sha>/character.json`.
  const files = current.characters.map((c) => c.definition.file.split('/'));
  const ids = new Set(files.map((parts) => parts[1])), kept = new Set(files.map((parts) => parts.slice(0, 3).join('/')));
  const packages = join(library, 'packages');
  for (const id of existsSync(packages) ? readdirSync(packages) : []) {
    if (!ids.has(id)) {
      rmSync(join(packages, id), { recursive: true });
      continue;
    }
    for (const entry of readdirSync(join(packages, id), { withFileTypes: true })) {
      if (entry.isDirectory() && !kept.has(`packages/${id}/${entry.name}`)) rmSync(join(packages, id, entry.name), { recursive: true });
    }
  }
  for (const name of readdirSync(library)) {
    if ((/^catalog-.*\.json$/.test(name) && name !== `catalog-${current.revision}.json`)
      || (/^native-.*\.json$/.test(name) && name !== current.native_bundle?.file)) rmSync(join(library, name));
  }
}

/**
 * After the instance lock: imports and resolves the components, seeds or migrates the character library,
 * and writes config.json: managed paths recomputed on every launch, user settings and a user's catalog kept, the old file
 * backed up first. Throws ConfigError when the components, the seed or the prospective config are unusable; config.json is
 * unchanged then. Null without distribution.json.
 */
export function preparePackaged(options: { resources: string; supportBase: string; agentdStateDir: string; platform: ShellPlatform },
  ports: PackagedPorts = nodePorts): PackagedLaunch | null {
  const { resources, platform } = options;
  const manifest = distribution(resources);
  if (manifest === null) return null;
  const hash = manifest.catalogSHA256;
  const support = join(options.supportBase, manifest.id);
  mkdirSync(support, { recursive: true, mode: 0o700 });
  chmodSync(support, 0o700);
  // The .app bundle; on Windows the portable directory.
  const avatar = platform === 'windows' ? dirname(resources) : dirname(dirname(resources));
  const resolved = prepareComponents({ resources, support, layout: manifest.layout, platform });
  const flags = pythonFlags(true, platform);
  // The components a seed library needs but lacks.
  const seedLacking = Object.keys(resolved.missing)
    .filter((id) => id.startsWith('characters.') || id === 'agentd' || id === 'runtime.python').sort();
  const seedTools = (): { agentd: string; python: string } => {
    if (seedLacking.length > 0 || resolved.agentd === null || resolved.python === null) {
      throw new ConfigError(`发行角色库缺组件：${seedLacking.join(' ')}`);
    }
    return { agentd: resolved.agentd, python: resolved.python };
  };
  const checkCatalog = (path: string): void => {
    if (readCatalog(path) === null) throw new ConfigError(`角色目录不存在：${path}`);
  };
  // Composes the `characters.` payloads into a new library at `output`; returns its `current.json`, checked against the seed.
  const compose = (output: string): string => {
    const { agentd, python } = seedTools();
    const r = ports.run(python, [...flags, join(agentd, 'character_tool.py'), 'compose', ...resolved.characters.flatMap((p) => ['--package', p]),
      ...(manifest.defaultCharacter === null ? [] : ['--default', manifest.defaultCharacter]), '--output', output]);
    if (r.status !== 0) throw new ConfigError(`发行角色库合成失败：${r.stderr}`);
    const catalog = join(output, 'current.json');
    if (sha256(readFileSync(catalog)) !== hash) throw new ConfigError('发行角色目录 SHA 不匹配');
    return catalog;
  };
  const configPath = join(support, 'config.json');
  const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  let config: Record<string, unknown>;
  if (original !== null) {
    const existing: unknown = JSON.parse(original);
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) throw new ConfigError('发行配置不是对象');
    config = existing as Record<string, unknown>;
  } else {
    config = {
      agentd_port: manifest.port, gpu_hold_files: [], characters: [],
      // Not control+space: macOS switches the input source on it.
      voice_hotkey: 'right_option', hotkey_quick_input: 'control+option+space', hotkey_look: 'control+option+l',
      hotkey_toggle_avatar: 'control+option+h', hotkey_click_through: 'control+option+p', hotkey_radial_menu: '',
      hotkey_selection: 'control+option+s', viewport: 'fullscreen',
      observe_activity: false, sense_input_counts: false, sense_audio_apps: false,
      share_page_text: false, share_window_text: false, share_typed_text: false, share_actions: false, share_agent_sessions: true,
      share_screenshots: false, computer_use_enabled: false,
      proactive_speech: false, mute: false, voice_service: 'local', tts_url: '', tts_tunnel_host: '',
      system_notifications: false, hide_on_screen_capture: platform !== 'windows',
    };
  }
  const logDir = () => (typeof config.support_dir === 'string' ? config.support_dir : support);
  let migrationLog: string | null = null;
  if (typeof config.character_catalog === 'string' && !existsSync(config.character_catalog)) {
    appendLog(logDir(), 'companion', `ERROR config character_catalog missing: ${config.character_catalog}`);
    delete config.character_catalog;
  }
  const library = join(support, 'character-libraries', `seed-${hash.slice(0, 16)}`);
  // Every path but the first launch without a seed library drops it.
  delete config.character_library_missing;
  if (!Object.hasOwn(config, 'character_catalog') && !existsSync(library) && seedLacking.length > 0) {
    // A later launch with every seed component builds it; until then the config needs one character.
    appendLog(logDir(), 'companion', `seed library not built: ${seedLacking.join(' ')}`);
    config.character_library_missing = seedLacking;
    if ((Array.isArray(config.characters) ? config.characters : []).length === 0 && manifest.defaultCharacter !== null) {
      config.characters = [{ id: manifest.defaultCharacter, name: manifest.defaultCharacter, avatar_app: avatar, avatar_args: [] }];
    }
  } else if (!Object.hasOwn(config, 'character_catalog')) {
    if (!existsSync(library)) {
      const stage = join(support, `.characters-${randomUUID()}`);
      try {
        checkCatalog(compose(stage));
        writeAtomic(join(stage, 'distribution-seed.json'), JSON.stringify({ schema: 'endfield-distribution-seed/v1', seed_sha256: hash }));
        mkdirSync(dirname(library), { recursive: true });
        try {
          renameSync(stage, library);
        } catch (e) {
          if (!existsSync(library)) throw e;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    const catalog = join(library, 'current.json');
    checkCatalog(catalog);
    config.character_catalog = catalog;
  } else if (typeof config.character_catalog === 'string') {
    const previous = config.character_catalog;
    let marked: unknown;
    try {
      marked = JSON.parse(readFileSync(join(dirname(previous), 'distribution-seed.json'), 'utf8')).seed_sha256;
    } catch {
      // A catalog without a readable marker is not this seed's.
      marked = undefined;
    }
    if (marked !== hash && seedLacking.length > 0) {
      // The existing library stays; a later launch with every seed component migrates it.
      appendLog(logDir(), 'companion', `seed migration deferred: ${seedLacking.join(' ')}`);
    } else if (marked !== hash) {
      const { agentd, python } = seedTools();
      const priorHash = sha256(readFileSync(previous));
      const next = join(support, 'character-libraries', `seed-${hash.slice(0, 16)}-from-${priorHash.slice(0, 16)}`);
      const log = join(support, 'seed-migration.log');
      writeFileSync(log, '', { mode: 0o600 });
      chmodSync(log, 0o600);
      const seed = join(support, `.characters-${randomUUID()}`);
      try {
        const seedCatalog = compose(seed);
        const r = ports.run(python, [...flags, join(agentd, 'distribution_seed.py'), '--seed-catalog', seedCatalog, '--seed-sha256', hash,
          '--existing-catalog', previous, '--existing-sha256', priorHash, '--output', next,
          ...(resolved.renderer === null ? [] : ['--validate-with', resolved.renderer])], log);
        if (r.status !== 0) throw new ConfigError(`角色库迁移失败，原目录未替换；见 ${log}`);
      } finally {
        rmSync(seed, { recursive: true, force: true });
      }
      const catalog = join(next, 'current.json');
      checkCatalog(catalog);
      config.character_catalog = catalog;
      migrationLog = log;
    }
  }
  // Recompute managed paths on every launch so moving the app is safe.
  config.avatar_app = avatar;
  setComposition(config, resolved);
  if (!Object.hasOwn(config, 'support_dir')) config.support_dir = support;
  if (!Object.hasOwn(config, 'agentd_state_dir')) config.agentd_state_dir = options.agentdStateDir;
  // Sorted keys, at every level.
  const text = JSON.stringify(config, (_key, value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value), 2);
  // Validate the complete prospective config before changing the old one.
  parseConfig(text, { supportDir: support, agentdStateDir: options.agentdStateDir, catalog: (path) => readCatalog(path) });
  if (original !== text) {
    writeAtomic(configPath, text, 0o600);
    if (migrationLog !== null && typeof config.character_catalog === 'string') {
      // Old generations only pin blocks of replaced app bundles; the new one holds its own clones.
      const current = basename(dirname(config.character_catalog)), libraries = join(support, 'character-libraries');
      const stale = [
        ...readdirSync(libraries).filter((n) => (n.startsWith('seed-') && n !== current) || n.startsWith('.seed-')).map((n) => join(libraries, n)),
        ...readdirSync(support).filter((n) => n.startsWith('.characters-')).map((n) => join(support, n)),
      ];
      for (const dir of stale) {
        try {
          rmSync(dir, { recursive: true });
        } catch (e) {
          appendFileSync(migrationLog, `旧角色库未能删除：${dir}：${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
  }
  if (typeof config.character_catalog === 'string' && dirname(dirname(config.character_catalog)) === join(support, 'character-libraries')) {
    pruneLibrary(dirname(config.character_catalog));
  }
  return { configPath, composition: resolved, webRoot: resolved.webUI === null ? null : join(resolved.webUI, 'ui') };
}
