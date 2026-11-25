// The shared MMD library's bake into the current character: `mmd.syncState`, the `mmd.onSync` events, and the `busy` the imports, renames and removals answer meanwhile.
import { MotionFailureError } from './character.ts';
import { type ImportProgress, moves } from './import-state.ts';

/** `mmd.syncState`: `character` and `stage` are null while idle; `total`, `done`, `failed` (dances that did not bake) and
 *  `fraction` stay from the last run. */
export interface MmdSyncState {
  running: boolean;
  character: string | null;
  total: number;
  done: number;
  failed: number;
  /** An ImportProgress stage. */
  stage: string | null;
  fraction: number;
}

export const MMD_SYNC_IDLE: MmdSyncState = { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 };

/** The result line of `motion_tool.py mmd-sync`. */
export interface MmdSyncResult {
  character: string;
  version: string;
  baked: string[];
  renamed: string[];
  /** Dances whose music alone was swapped for the library's. */
  music: string[];
  removed: string[];
  failed: { id: string; reason: string; detail: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** The sync's arguments after the script. */
export function mmdSyncArgs(library: string, character: string, host: string): string[] {
  return ['mmd-sync', '--library', library, '--character', character, '--validate-with', host];
}

/** The line decoded as MmdSyncResult; an `internal` failure when it is not one. */
export function mmdSyncResult(line: string): MmdSyncResult {
  let o: unknown = null;
  try {
    o = JSON.parse(line);
  } catch { /* falls through to the failure */ }
  if (isObject(o) && typeof o.character === 'string' && typeof o.version === 'string' && strings(o.baked) && strings(o.renamed)
    && strings(o.music) && strings(o.removed) && Array.isArray(o.failed)
    && o.failed.every((f) => isObject(f) && typeof f.id === 'string' && typeof f.reason === 'string' && typeof f.detail === 'string')) {
    return { character: o.character, version: o.version, baked: o.baked, renamed: o.renamed, music: o.music, removed: o.removed,
      failed: (o.failed as Record<string, string>[]).map((f) => ({ id: f.id!, reason: f.reason!, detail: f.detail! })) };
  }
  throw new MotionFailureError({ reason: 'internal', detail: `motion_tool printed no result: ${line}` });
}

export interface MmdSyncPorts {
  /** `mmd-sync` for a character with its progress lines; null once `signal` stopped it. Throws the tool's failure. */
  run(character: string, progress: (p: ImportProgress) => void, signal: AbortSignal): Promise<MmdSyncResult | null>;
  /** Restarts the renderer and waits until it is back. */
  reload(): Promise<void>;
  /** The switch's current character. */
  current(): string | null;
  /** Gets every state. */
  send(state: MmdSyncState): void;
  log(line: string): void;
}

/** Keeps the shared MMD library baked into the current character: each new current character cancels the running sync and
 *  starts its own. A sync leaves switching free; imports refuse while it runs. */
export class MmdSync {
  private current: MmdSyncState = MMD_SYNC_IDLE;
  private readonly ports: MmdSyncPorts;
  private task: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  /** The character the last sync was started for. */
  private followed: string | null = null;

  constructor(ports: MmdSyncPorts) {
    this.ports = ports;
  }

  get state(): MmdSyncState {
    return this.current;
  }

  private set(state: MmdSyncState): void {
    this.current = state;
    this.ports.send(state);
  }

  /** The switch's current character, on every change of its view; the returned promise ends with the sync it started. */
  follow(current: string | null): Promise<void> {
    if (current === null || current === this.followed) return this.task;
    this.followed = current;
    const previous = this.task;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.task = (async () => {
      // The cancelled tool keeps the library lock until it has exited.
      await previous;
      if (abort.signal.aborted) return;
      this.set({ running: true, character: current, total: 0, done: 0, failed: 0, stage: null, fraction: 0 });
      let failed = 0;
      try {
        const result = await this.ports.run(current, (p) => {
          const s = this.current;
          if (abort.signal.aborted || (!moves(p, s.stage, s.fraction) && (p.total ?? s.total) === s.total)) return;
          this.set({ running: true, character: current, total: p.total ?? s.total, done: p.done ?? s.done, failed: 0, stage: p.stage,
            fraction: p.fraction });
        }, abort.signal);
        if (result === null) return;
        failed = result.failed.length;
        if (result.baked.length + result.renamed.length + result.music.length + result.removed.length > 0 && this.ports.current() === current) {
          await this.ports.reload();
        }
      } catch (e) {
        this.ports.log(`mmd-sync ${current} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (abort.signal.aborted) return;
      const s = this.current;
      this.set({ running: false, character: null, total: s.total, done: s.done, failed, stage: null, fraction: s.fraction });
    })();
    return this.task;
  }

  /** Throws `busy` while a sync rewrites the current character's package. */
  checkIdle(): void {
    if (this.current.running) throw new MotionFailureError({ reason: 'busy', detail: '正在为角色转换共享库中的 MMD 动作' });
  }
}
