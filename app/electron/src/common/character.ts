// The character library ops' values (`character.*`, `playlist.*`, `mmd.*`): character.list entries, motion_tool
// lines and failures, config.json `motion_playlists`.
import { BridgeFailure } from './bridge.ts';
import { parseCharacterDefinition } from './config.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** protocol.ts `CharacterEntry` of a package's `character.json`. Appearances and layers come from the renderer, so none yet;
 *  head, portrait and background depend on the package's files. `voice`: the package has a voice profile (character_library.py
 *  `voice_enabled`). */
export function characterEntry(definition: string, id: string, active: boolean): Json {
  const { name } = parseCharacterDefinition(definition, id);
  const def = JSON.parse(definition) as Json;
  const names = isObject(def.display) && isObject(def.display.name) ? def.display.name : {};
  const voice = isObject(def.components) && def.components.voice != null;
  return { id, name, en: typeof names.en === 'string' ? names.en : '', active, appearances: [], voice };
}

/** An action id of 1–64 UTF-8 bytes, else null. */
export function motionID(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bytes = new TextEncoder().encode(value).length;
  return bytes >= 1 && bytes <= 64 ? value : null;
}

/** A trimmed title of 1–64 characters, else null. */
export function motionTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  const count = [...new Intl.Segmenter().segment(title)].length;
  return count >= 1 && count <= 64 ? title : null;
}

export interface MotionFailure { reason: string; detail: string }

const REASONS = new Set(['too_many_actions', 'too_many_media', 'bad_vmd', 'too_long', 'missing_bones', 'busy', 'validate_failed',
  'internal', 'unsupported_format', 'bad_source', 'no_animation', 'unmapped_skeleton', 'already_imported', 'unknown_action',
  'not_imported', 'bad_title', 'bad_zip', 'linked_motion', 'outside_package']);

/** motion_tool's failure: its last stderr line `{reason, detail}` with a known reason, else `internal` with the stderr's end. */
export function toolFailure(stderr: string): MotionFailure {
  const last = stderr.split(/\r?\n/).filter((l) => l !== '').at(-1) ?? '';
  try {
    const line: unknown = JSON.parse(last);
    if (isObject(line) && typeof line.reason === 'string' && REASONS.has(line.reason)) {
      return { reason: line.reason, detail: typeof line.detail === 'string' ? line.detail : '' };
    }
  } catch { /* not a failure line */ }
  return { reason: 'internal', detail: stderr.slice(-2000).trim() };
}

/** The tool's result line as an object; an `internal` failure when it printed none. */
export function resultLine(line: string): Json {
  try {
    const o: unknown = JSON.parse(line);
    if (isObject(o)) return o;
  } catch { /* falls through */ }
  throw new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${line}` });
}

export class MotionFailureError extends Error {
  readonly failure: MotionFailure;

  constructor(failure: MotionFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

/** `{ok: true, ...fields}`, or motion_tool's `{ok: false, reason, detail}`. */
export function motionReply(result: Json | MotionFailure, ok: boolean): Json {
  return ok ? { ...result, ok: true } : { ok: false, reason: result.reason, detail: result.detail };
}

/** motion_tool `list`'s motions as `character.listImportedMotions` sends them. */
export function importedMotions(line: Json): Json[] {
  if (!Array.isArray(line.motions)) throw new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${JSON.stringify(line)}` });
  return line.motions.map((m: Json) => ({ id: m.id, clip: m.clip, title: m.title, format: m.format, durationS: m.duration_s,
    hasBgm: m.has_bgm, createdAt: m.created_at ?? null, warnings: m.warnings }));
}

/** motion_tool `mmd-list`'s entries as `mmd.list` sends them. */
export function mmdEntries(line: Json): Json[] {
  if (!Array.isArray(line.entries)) throw new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${JSON.stringify(line)}` });
  return line.entries.map((e: Json) => ({ id: e.id, title: e.title, durationS: e.duration_s, hasBgm: e.has_bgm, hasCamera: e.has_camera,
    hasFace: e.has_face === true, project: e.project ?? null, role: e.role ?? null, createdAt: e.created_at,
    characters: (Array.isArray(e.characters) ? e.characters : []).map((c: Json) => ({ id: c.id, state: c.state, reason: c.reason ?? null })) }));
}

/** The files `characters/<id>/<kind>.png` may name. */
export type ArtKind = 'head' | 'portrait' | 'background';

export interface AssetReference { file: string; sha256: string; byteCount: number }

const EXECUTABLE_SUFFIXES = new Set(['py', 'pyc', 'sh', 'command', 'dylib', 'so', 'exe', 'dll']);

/** CharacterPackage.validate's path rule: relative, `/`-separated, no empty, `.` or `..` part, no backslash or NUL. */
export function isPackagePath(file: string): boolean {
  return !file.startsWith('/') && !file.includes('\\') && !file.includes('\0')
    && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The head, portrait or background before the file is read: `components.ui.<kind>` of `character.json` when it is a
 *  valid reference (CharacterPackage.validate) the inventory lists; null otherwise. */
export function artReference(definition: string, kind: ArtKind): AssetReference | null {
  const def: unknown = JSON.parse(definition);
  if (!isObject(def) || !isObject(def.components) || !isObject(def.components.ui)) return null;
  const ref = def.components.ui[kind];
  if (!isObject(ref) || typeof ref.file !== 'string' || typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256)
    || !Number.isInteger(ref.byte_count) || (ref.byte_count as number) < 0 || !isPackagePath(ref.file)) return null;
  const { file, sha256 } = ref, byteCount = ref.byte_count as number;
  if (EXECUTABLE_SUFFIXES.has(/\.([^./]*)$/.exec(file)?.[1]?.toLowerCase() ?? '')) return null;
  const listed = Array.isArray(def.inventory) && def.inventory.some((r) => isObject(r) && r.file === file && r.sha256 === sha256
    && r.byte_count === byteCount);
  return listed ? { file, sha256, byteCount } : null;
}

export interface Playlist { items: string[]; loop: 'off' | 'one' | 'all'; speed: number }

const LOOPS = ['off', 'one', 'all'];
const SPEEDS = [0.5, 1, 2];

/** config.json `motion_playlists`: entries without an `items` array and invalid ids are
 *  dropped; an unknown `loop` is `off`, an unknown `speed` is 1. */
export function decodePlaylists(value: unknown): Record<string, Playlist> {
  if (!isObject(value)) return {};
  const table: Record<string, Playlist> = {};
  for (const [character, raw] of Object.entries(value)) {
    if (!isObject(raw) || !Array.isArray(raw.items)) continue;
    const items = raw.items.filter((i): i is string => motionID(i) !== null).slice(0, 128);
    const loop = typeof raw.loop === 'string' && LOOPS.includes(raw.loop) ? raw.loop as Playlist['loop'] : 'off';
    const speed = typeof raw.speed === 'number' && SPEEDS.includes(raw.speed) ? raw.speed : 1;
    table[character] = { items, loop, speed };
  }
  return table;
}

/** `character.setPlaylist`'s argument: at most 128 action ids, `off|one|all`, 0.5, 1 or 2. */
export function playlistArg(value: unknown): Playlist {
  if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 128 || typeof value.loop !== 'string'
    || !LOOPS.includes(value.loop) || typeof value.speed !== 'number' || !SPEEDS.includes(value.speed)) {
    throw new BridgeFailure('invalid_args', '{items, loop: off|one|all, speed: 0.5|1|2}');
  }
  if (!value.items.every((i) => motionID(i) !== null)) throw new BridgeFailure('invalid_args', 'items: action ids of 1-64 bytes');
  return { items: value.items as string[], loop: value.loop as Playlist['loop'], speed: value.speed };
}
