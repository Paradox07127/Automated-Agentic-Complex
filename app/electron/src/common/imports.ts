// The motion, MMD and outfit imports' rules: which files the panels offer, the tools' command lines after the script, their result and failure lines.
import { BridgeFailure } from './bridge.ts';
import { MotionFailureError, motionTitle } from './character.ts';

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

const noResult = (line: string) => new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${line}` });

/** The action of a motion_tool import result `o`; null when a field is missing or of the wrong type. */
function actionOf(o: unknown): Json | null {
  const action = isObject(o) ? o.action : undefined;
  if (isObject(o) && o.ok === true && isObject(action) && typeof action.id === 'string' && typeof action.title === 'string'
    && typeof action.duration_s === 'number' && typeof action.has_bgm === 'boolean'
    && (o.format === undefined || o.format === null || typeof o.format === 'string')
    && (o.warnings === undefined || o.warnings === null || isStrings(o.warnings))) {
    return { id: action.id, title: action.title, durationS: action.duration_s, hasBgm: action.has_bgm, format: o.format ?? 'vmd',
      warnings: o.warnings ?? [] };
  }
  return null;
}

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** motion_tool import's result line as `character.importMotion` and `mmd.importScan` send the action. */
export function importedMotion(line: string): Json {
  const action = actionOf(parsed(line));
  if (action === null) throw noResult(line);
  return action;
}

/** MMD files the import panel offers: VMD, a ZIP of them, and the music. */
export const MMD_SCAN_EXTENSIONS = [...pickerExtensions(MMD_EXTENSIONS), ...BGM_EXTENSIONS];

/** motion_tool mmd-scan: the first chosen path is the source, the rest extras; it unpacks a ZIP into `unpackTo`, which must not exist. */
export function mmdScanArgs(paths: string[], unpackTo: string): string[] {
  return ['mmd-scan', '--source', paths[0]!, ...paths.slice(1).flatMap((p) => ['--extra', p]), '--unpack-to', unpackTo];
}

export interface MmdScanBody { path: string; name: string; label: string; model: string; durationS: number; placeFrame: number | null; hasMorph: boolean }
export interface MmdScan {
  title: string; root: string;
  bodies: MmdScanBody[];
  faces: { path: string; name: string; durationS: number; morphs: number }[];
  cameras: { path: string; name: string; durationS: number; placeFrame: number | null }[];
  audio: { path: string; name: string }[];
  ignored: { name: string; reason: string }[];
  suggested: { body: number; face: number | null; camera: number | null; audio: number | null; bgmStartS: number | null };
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const orNull = (ok: (v: unknown) => boolean) => (v: unknown) => v === null || ok(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** `list`'s items, each read by `item`; null when it is no array or an item does not read. */
function listOf<T>(list: unknown, item: (o: Json) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const out: T[] = [];
  for (const o of list) {
    const read = isObject(o) ? item(o) : null;
    if (read === null) return null;
    out.push(read);
  }
  return out;
}

/** The object of `o`'s fields when each passes its check, else null. */
function fields<T>(o: Json, checks: Record<string, (v: unknown) => boolean>, made: (o: Json) => T): T | null {
  return Object.entries(checks).every(([k, ok]) => ok(o[k])) ? made(o) : null;
}

/** motion_tool mmd-scan's result line in camelCase. */
export function scannedMmd(line: string): MmdScan {
  const o = parsed(line);
  if (!isObject(o) || o.ok !== true || !isString(o.title) || !isString(o.root) || !isObject(o.suggested)) throw noResult(line);
  const bodies = listOf(o.bodies, (b) => fields(b, { path: isString, name: isString, label: isString, model: isString, duration_s: isNumber,
    place_frame: orNull(Number.isInteger), has_morph: (v) => typeof v === 'boolean' }, (b): MmdScanBody => ({ path: b.path as string,
    name: b.name as string, label: b.label as string, model: b.model as string, durationS: b.duration_s as number,
    placeFrame: b.place_frame as number | null, hasMorph: b.has_morph as boolean })));
  const faces = listOf(o.faces, (f) => fields(f, { path: isString, name: isString, duration_s: isNumber, morphs: Number.isInteger },
    (f) => ({ path: f.path as string, name: f.name as string, durationS: f.duration_s as number, morphs: f.morphs as number })));
  const cameras = listOf(o.cameras, (c) => fields(c, { path: isString, name: isString, duration_s: isNumber, place_frame: orNull(Number.isInteger) },
    (c) => ({ path: c.path as string, name: c.name as string, durationS: c.duration_s as number, placeFrame: c.place_frame as number | null })));
  const audio = listOf(o.audio, (a) => fields(a, { path: isString, name: isString }, (a) => ({ path: a.path as string, name: a.name as string })));
  const ignored = listOf(o.ignored, (i) => fields(i, { name: isString, reason: isString }, (i) => ({ name: i.name as string, reason: i.reason as string })));
  const s = o.suggested;
  const suggested = fields(s, { body: isIndex, face: orNull(isIndex), camera: orNull(isIndex), audio: orNull(isIndex), bgm_start_s: orNull(isNumber) },
    (s) => ({ body: s.body as number, face: s.face as number | null, camera: s.camera as number | null, audio: s.audio as number | null,
      bgmStartS: s.bgm_start_s as number | null }));
  if (bodies === null || faces === null || cameras === null || audio === null || ignored === null || suggested === null) throw noResult(line);
  return { title: o.title, root: o.root, bodies, faces, cameras, audio, ignored, suggested };
}

export interface MmdImportPlan {
  token: string;
  items: { body: number; title: string }[];
  face: number | null; camera: number | null; audio: number | null;
  bgmStartS: number | null;
  project: string;
}

/** `mmd.importScan`'s plan against the pending `scan`: one or more distinct bodies with 1–64-character titles, a face, camera
 *  and music of the scan or none, a finite offset or none; trimmed. Anything else is bad_args. */
export function mmdPlanArg(value: unknown, scan: MmdScan): MmdImportPlan {
  const bad = new BridgeFailure('bad_args', 'mmd.importScan');
  if (!isObject(value) || !isString(value.token) || !Array.isArray(value.items) || value.items.length === 0) throw bad;
  const inside = (v: unknown, list: unknown[]) => v === null || (isIndex(v) && v < list.length);
  const items = value.items.map((i: unknown) => {
    const title = isObject(i) ? motionTitle(i.title) : null;
    if (!isObject(i) || title === null || !isIndex(i.body) || i.body >= scan.bodies.length) throw bad;
    return { body: i.body, title };
  });
  const project = motionTitle(value.project);
  if (new Set(items.map((i) => i.body)).size !== items.length || !inside(value.face, scan.faces) || !inside(value.camera, scan.cameras)
    || !inside(value.audio, scan.audio) || !orNull(isNumber)(value.bgmStartS) || project === null) throw bad;
  return { token: value.token, items, face: value.face as number | null, camera: value.camera as number | null,
    audio: value.audio as number | null, bgmStartS: value.bgmStartS as number | null, project };
}

export interface MmdImportItem {
  source: string; morph: string | null; camera: string | null; bgm: string | null; bgmStartS: number | null;
  title: string; project: string; role: string;
}

/** motion_tool import of one scanned body; the offset goes only with music. `=` keeps a value that starts with `-` a value. */
export function mmdImportArgs(library: string, character: string, item: MmdImportItem, host: string): string[] {
  return ['import', '--library', library, '--character', character, '--source', item.source,
    ...(item.morph === null ? [] : ['--morph', item.morph]), ...(item.camera === null ? [] : ['--camera', item.camera]),
    ...(item.bgm === null ? [] : ['--bgm', item.bgm, ...(item.bgmStartS === null ? [] : [`--bgm-start=${item.bgmStartS}`])]),
    `--title=${item.title}`, `--project=${item.project}`, `--role=${item.role}`, '--validate-with', host];
}

/** motion_tool mmd-media: the entry `action` with new music (`--no-bgm` for none) and its offset. */
export function mmdMediaArgs(library: string, character: string, action: string, bgm: string | null, bgmStartS: number | null,
  host: string): string[] {
  return ['mmd-media', '--library', library, '--character', character, `--action=${action}`,
    ...(bgm === null ? ['--no-bgm'] : ['--bgm', bgm, ...(bgmStartS === null ? [] : [`--bgm-start=${bgmStartS}`])]), '--validate-with', host];
}

/** motion_tool mmd-media's result line: the entry's action, its id unchanged, with its new music. */
export function mediaChanged(line: string): Json {
  const action = actionOf(parsed(line));
  if (action === null) throw noResult(line);
  return action;
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
