// The motion, MMD and outfit imports' rules: which files the panels offer, the tools' command lines after the script, their result and failure lines.
import { BridgeFailure } from './bridge.ts';
import { MotionFailureError } from './character.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

export const MOTION_EXTENSIONS = ['vmd', 'bvh', 'glb', 'gltf', 'vrma', 'fbx'];
/** The shared MMD library's. */
export const MMD_EXTENSIONS = ['vmd'];
/** motion/zip_import.py AUDIO. */
export const BGM_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'aif', 'aiff'];

/** A ZIP carries MMD files only, so it is offered only while VMD is. */
export function pickerExtensions(motion: string[]): string[] {
  return motion.includes('vmd') ? [...motion, 'zip'] : motion;
}

/** The last path component, by either separator. */
const fileName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;
const extensionOf = (path: string): string => {
  const name = fileName(path), dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export interface MotionFiles { source: string; extras: string[]; asksBgm: boolean }

/** The panel's choice: motion_tool unpacks only `--source`, so a ZIP has to be it. Only a single non-ZIP file asks for a BGM. A file
 *  of a type the panel did not offer is `unsupported_format`. */
export function motionFiles(paths: string[], motion: string[]): MotionFiles {
  const offered = pickerExtensions(motion);
  const wrong = paths.find((p) => !offered.includes(extensionOf(p)));
  if (wrong !== undefined) throw new MotionFailureError({ reason: 'unsupported_format', detail: fileName(wrong) });
  const source = paths.find((p) => extensionOf(p) === 'zip') ?? paths[0]!;
  const extras = paths.filter((p) => p !== source);
  return { source, extras, asksBgm: extras.length === 0 && extensionOf(source) !== 'zip' };
}

/** The source file's name without its extension. */
export function motionImportTitle(source: string): string {
  const name = fileName(source), dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The first component running agentd's scripts needs that config.json
 *  `missing_components` names; null when neither is missing. */
export function firstMissingComponent(missing: unknown): string | null {
  return isObject(missing) ? ['agentd', 'runtime.python'].find((id) => Object.hasOwn(missing, id)) ?? null : null;
}

export function motionImportArgs(library: string, character: string, source: string, extras: string[], bgm: string | null,
  host: string): string[] {
  return ['import', '--library', library, '--character', character, '--source', source, ...extras.flatMap((e) => ['--extra', e]),
    ...(bgm === null ? [] : ['--bgm', bgm]), '--validate-with', host];
}

/** motion_tool import's result line as `character.importMotion` and `mmd.import` send the action. */
export function importedMotion(line: string): Json {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch { /* no result */ }
  const action = isObject(o) ? o.action : undefined;
  if (isObject(o) && o.ok === true && isObject(action) && typeof action.id === 'string' && typeof action.title === 'string'
    && typeof action.duration_s === 'number' && typeof action.has_bgm === 'boolean'
    && (o.format === undefined || o.format === null || typeof o.format === 'string')
    && (o.warnings === undefined || o.warnings === null || isStrings(o.warnings))) {
    return { id: action.id, title: action.title, durationS: action.duration_s, hasBgm: action.has_bgm, format: o.format ?? 'vmd',
      warnings: o.warnings ?? [] };
  }
  throw new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${line}` });
}

export function outfitImportArgs(library: string, character: string, source: string, host: string): string[] {
  return ['import', '--library', library, '--character', character, '--source', source, '--validate-with', host];
}

export function outfitRemoveArgs(library: string, character: string, appearance: string, host: string): string[] {
  return ['remove', '--library', library, '--character', character, '--appearance', appearance, '--validate-with', host];
}

export interface ImportedOutfit { id: string; name: string; warnings: string[] }

export function importedOutfit(line: string): ImportedOutfit {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch { /* no result */ }
  const appearance = isObject(o) ? o.appearance : undefined;
  if (isObject(o) && o.ok === true && isObject(appearance) && typeof appearance.id === 'string' && typeof appearance.name === 'string'
    && (o.warnings === undefined || o.warnings === null || isStrings(o.warnings))) {
    return { id: appearance.id, name: appearance.name, warnings: o.warnings ?? [] };
  }
  throw new BridgeFailure('internal', `outfit_tool printed no result: ${line}`);
}

/** outfit_tool's last stderr line `{reason, detail}` with any reason, else `internal` with the stderr's end; an import's detail
 *  starts with the mod folder's name, which outfit_tool's does not say. */
export function outfitFailure(stderr: string, folder: string | null): BridgeFailure {
  const last = stderr.split(/\r?\n/).filter((l) => l !== '').at(-1) ?? '';
  let failure = { reason: 'internal', detail: stderr.slice(-2000).trim() };
  try {
    const line: unknown = JSON.parse(last);
    if (isObject(line) && typeof line.reason === 'string') failure = { reason: line.reason, detail: typeof line.detail === 'string' ? line.detail : '' };
  } catch { /* not a failure line */ }
  return new BridgeFailure(failure.reason, folder === null ? failure.detail : `${folder}: ${failure.detail}`);
}
