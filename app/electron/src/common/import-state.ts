// The motion, MMD and outfit imports' progress: the tools' progress lines, and the state
// `character.importState` answers and `character.onImport` sends.

const STAGES = new Set(['read', 'sample', 'retarget', 'compose', 'write', 'validate', 'publish']);

/** A motion_tool or outfit_tool `{"event": "progress", ...}` stdout line, printed before the result line. */
export interface ImportProgress {
  /** One of the tools' stages; null on a line without one. */
  stage: string | null;
  /** The whole subcommand's progress, 0–1. */
  fraction: number;
  /** `mmd-sync`'s entry counts. */
  total?: number;
  done?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown): v is undefined | null => v === undefined || v === null;

/** Null for any other line, or one whose fields have the wrong types; a line without `fraction` gets done/total. */
export function parseProgress(line: string): ImportProgress | null {
  let p: unknown;
  try {
    p = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(p) || p.event !== 'progress') return null;
  const { stage, fraction, total, done } = p;
  if (!(absent(stage) || typeof stage === 'string') || !(absent(fraction) || typeof fraction === 'number')
    || !(absent(total) || Number.isInteger(total)) || !(absent(done) || Number.isInteger(done))) return null;
  let value: number;
  if (typeof fraction === 'number') value = fraction;
  else if (typeof total === 'number' && typeof done === 'number') value = total > 0 ? done / total : 0;
  else return null;
  return { stage: typeof stage === 'string' && STAGES.has(stage) ? stage : null, fraction: Math.min(Math.max(value, 0), 1),
    ...(typeof total === 'number' ? { total } : {}), ...(typeof done === 'number' ? { done } : {}) };
}

/** Whether a bar showing `stage` at `fraction` should move to `p`: a new stage, or a change of 0.01 or more. */
export function moves(p: ImportProgress, stage: string | null, fraction: number): boolean {
  return p.stage !== stage || Math.abs(p.fraction - fraction) >= 0.01;
}

export type ImportKind = 'motion' | 'mmd' | 'outfit';

/** `character.importState`: the import running now. `stage` is a progress line's, `reload` once the tool has exited and the
 *  renderer restarts, or null before the tool's first stage and while idle. */
export interface ImportState {
  running: boolean;
  kind: ImportKind | null;
  /** The chosen file's name without its extension, or the chosen folder's name. */
  title: string | null;
  stage: string | null;
  fraction: number;
}

export const IMPORT_IDLE: ImportState = { running: false, kind: null, title: null, stage: null, fraction: 0 };

const same = (a: ImportState, b: ImportState) =>
  a.running === b.running && a.kind === b.kind && a.title === b.title && a.stage === b.stage && a.fraction === b.fraction;

/** The state of the import running now; `send` gets each change. */
export class ImportTracker {
  private current: ImportState = IMPORT_IDLE;
  private readonly send: (state: ImportState) => void;

  constructor(send: (state: ImportState) => void) {
    this.send = send;
  }

  get state(): ImportState {
    return this.current;
  }

  private set(state: ImportState): void {
    if (same(state, this.current)) return;
    this.current = state;
    this.send(state);
  }

  /** Runs `tool` with its progress lines shown, then `reload` at stage `reload`; idle again once either ends. */
  async run<T>(kind: ImportKind, title: string, tool: (progress: (p: ImportProgress) => void) => Promise<T>,
    reload: () => Promise<void>): Promise<T> {
    this.set({ running: true, kind, title, stage: null, fraction: 0 });
    try {
      const value = await tool((p) => {
        if (!this.current.running || !moves(p, this.current.stage, this.current.fraction)) return;
        this.set({ running: true, kind, title, stage: p.stage, fraction: p.fraction });
      });
      this.set({ running: true, kind, title, stage: 'reload', fraction: 1 });
      await reload();
      return value;
    } finally {
      this.set(IMPORT_IDLE);
    }
  }
}
