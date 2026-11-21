// `mmd.*` types: the MMD library every character shares (MOTION-IMPORT §8), re-exported by protocol.ts.
import type { MotionImportResult, Unsubscribe } from './protocol';

/** A dance in the MMD library every character shares, with its bake state on each character; `reason` is motion_tool's code of a failed bake. */
export interface MmdEntry {
  id: string;
  title: string;
  durationS: number;
  hasBgm: boolean;
  hasCamera: boolean;
  createdAt: string;
  characters: Array<{ id: string; state: 'baked' | 'pending' | 'failed'; reason: string | null }>;
}

export type MmdListResult = { ok: true; entries: MmdEntry[] } | { ok: false; reason: string; detail: string };

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
  /** As `character.importMotion`; the dance is baked for the current character and pending for the others. */
  import(): Promise<MotionImportResult>;
  syncState(): Promise<MmdSyncState>;
  onSync(cb: (s: MmdSyncState) => void): Unsubscribe;
}
