// `mmd.*` types: the MMD library every character shares, re-exported by protocol.ts.
import type { ImportedMotion, Unsubscribe } from './protocol';

/** A dance in the MMD library every character shares, with its bake state on each character; `reason` is motion_tool's code of a failed bake.
 *  `project` is the song it was imported from and `role` the part of it this dance is; both null for a single VMD. */
export interface MmdEntry {
  id: string;
  title: string;
  durationS: number;
  hasBgm: boolean;
  hasCamera: boolean;
  hasFace: boolean;
  project: string | null;
  role: string | null;
  createdAt: string;
  characters: Array<{ id: string; state: 'baked' | 'pending' | 'failed'; reason: string | null }>;
}

export type MmdListResult = { ok: true; entries: MmdEntry[] } | { ok: false; reason: string; detail: string };

/** motion_tool mmd-scan's sorting of an MMD project (a folder, a ZIP or files): the VMDs with bone keys, with morph keys only,
 *  with camera keys, the music, the files it left out, and its choice of each. `placeFrame` is a `[fN]` stem's N (30 fps). */
export interface MmdScan {
  /** The folder's name, the ZIP's stem or the file's stem. */
  title: string;
  root: string;
  bodies: Array<{ path: string; name: string; label: string; model: string; durationS: number; placeFrame: number | null; hasMorph: boolean }>;
  faces: Array<{ path: string; name: string; durationS: number; morphs: number }>;
  cameras: Array<{ path: string; name: string; durationS: number; placeFrame: number | null }>;
  audio: Array<{ path: string; name: string }>;
  /** `reason`: `not_motion`, `no_keys`, `bad_vmd`. */
  ignored: Array<{ name: string; reason: string }>;
  /** Indices into the lists; `bgmStartS` is the body's `placeFrame / 30`. */
  suggested: { body: number; face: number | null; camera: number | null; audio: number | null; bgmStartS: number | null };
}

/** `token` names the one scan the shell keeps until it is imported, dropped or scanned again. */
export type MmdScanResult = { ok: true; token: string; scan: MmdScan } | { ok: false; reason: string; detail?: string };

/** What to import of a scan: each body as its own dance with its title, the face, camera and music they share (indices, null for
 *  none), the music's offset in seconds (negative: silence before it), and the song's title. */
export interface MmdImportPlan {
  token: string;
  items: Array<{ body: number; title: string }>;
  face: number | null;
  camera: number | null;
  audio: number | null;
  bgmStartS: number | null;
  project: string;
}

/** The dances imported, in plan order; a failure stops the rest and lists those done before it. `scan_gone`: the scan was dropped. */
export type MmdImportScanResult = { ok: true; actions: ImportedMotion[] } | { ok: false; reason: string; detail?: string; actions: ImportedMotion[] };

/** The pending scan with the picked music in its `audio`, `audio` the index of it there. `scan_gone`: the scan was dropped. */
export type MmdPickAudioResult = { ok: true; scan: MmdScan; audio: number } | { ok: false; reason: string; detail?: string };

/** What one dance holds, for the MMD page's timeline and detail. */
export interface MmdDetail {
  id: string;
  /** The body VMD's file name as imported; null when the library entry has none. */
  source: string | null;
  /** From the import report of the character it was read from: the morph names that drove her face and those that did not. */
  face: { mapped: string[]; unmapped: string[]; blinkFromDance: boolean } | null;
  /** Cut times in seconds of the clip, and the narrowest and widest vertical field of view in degrees. */
  camera: { cuts: number[]; fovDeg: [number, number] } | null;
  bgm: { name: string; offsetS: number | null } | null;
  /** `bins` equal slices of the dance; each value 0–1. mouth: the largest mouth control weight in the slice; loudness: the music's
   *  RMS in the slice over the loudest slice. null without a face clip / without music. */
  lanes: { bins: number; mouth: number[] | null; loudness: number[] | null };
}

/** `not_baked`: no character has the dance yet; `unknown_action`: no such dance. */
export type MmdDetailResult = { ok: true; detail: MmdDetail } | { ok: false; reason: string; detail?: string };

/** The same id with other music: the current character's bake gets it now, the others on their next sync. */
export type MmdMediaResult = { ok: true; action: ImportedMotion } | { ok: false; reason: string; detail?: string };

/** The background bake of the library into `character` after a switch. */
export interface MmdSyncState {
  running: boolean;
  character: string | null;
  total: number;
  done: number;
  failed: number;
  /** An `ImportStage`; null while idle and on a run that reports only `done`/`total`. */
  stage: string | null;
  /** 0–1. */
  fraction: number;
}

/** A tool's stages (`read` … `publish`), then `reload` while the avatar restarts after the tool exited. */
export type ImportStage = 'read' | 'sample' | 'retarget' | 'compose' | 'write' | 'validate' | 'publish' | 'reload';

/** The motion, MMD or outfit import running now; `stage` is null before the tool's first stage and while idle. */
export interface ImportState {
  running: boolean;
  kind: 'motion' | 'mmd' | 'outfit' | null;
  /** The chosen file's name without its extension. */
  title: string | null;
  stage: ImportStage | null;
  /** 0–1. */
  fraction: number;
}

/** `character.importState` and `character.onImport`. Main surface only. */
export interface ImportStateOps {
  importState(): Promise<ImportState>;
  onImport(cb: (s: ImportState) => void): Unsubscribe;
}

/** `character.renameMotion`/`removeMotion` on an `mmd_` id change the library for every character. Main surface only. */
export interface MmdOps {
  list(): Promise<MmdListResult>;
  /** The dance `id` read from the current character's package when she has it baked, else from any character's that has. */
  detail(id: string): Promise<MmdDetailResult>;
  /** Asks for an MMD project and sorts it. With `capabilities.filesOrFolderPicker` one panel takes files and folders and `folder` is
   *  not read; otherwise it opens the folder panel when true, the files panel when false. `reason`: `cancelled` or motion_tool's code. */
  scan(o: { folder: boolean }): Promise<MmdScanResult>;
  /** Imports the plan's bodies in turn, as `character.importMotion` does; each dance is baked for the current character and
   *  pending for the others. The scan is gone afterwards. */
  importScan(plan: MmdImportPlan): Promise<MmdImportScanResult>;
  /** Deletes the scan's unpacked files; nothing for another token. */
  dropScan(token: string): Promise<void>;
  /** Asks for music anywhere for the scan `token` and adds it to the scan's `audio` once; `reason`: `cancelled` or `scan_gone`. */
  pickScanAudio(token: string): Promise<MmdPickAudioResult>;
  /** The dance `id`, its id kept and not baked again, given music picked in a panel (`pick`) or none (`none`), at the offset (null: none). */
  setMedia(id: string, media: { bgm: 'pick' | 'none'; bgmStartS: number | null }): Promise<MmdMediaResult>;
  syncState(): Promise<MmdSyncState>;
  onSync(cb: (s: MmdSyncState) => void): Unsubscribe;
}
