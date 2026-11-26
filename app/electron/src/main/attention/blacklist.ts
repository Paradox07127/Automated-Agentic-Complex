// `<agentd_state_dir>/blacklist.json` for the attention heartbeat.
import { type FSWatcher, readFileSync, statSync, watch as watchFs } from 'node:fs';
import { basename, dirname } from 'node:path';
import { type BlacklistRules, EMPTY_BLACKLIST, parseBlacklist } from '../../common/attention.ts';

export class BlacklistFile {
  private readonly path: string;
  private mtime: bigint | null = null;
  private current: BlacklistRules = EMPTY_BLACKLIST;
  private dirty = true;
  private watcher: FSWatcher | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Watches the file's directory so unmodified reads skip `statSync`. */
  watch(): this {
    if (this.watcher !== null) return this;
    const target = basename(this.path);
    try {
      this.watcher = watchFs(dirname(this.path), (_event, filename) => {
        if (!filename || filename === target) this.dirty = true;
      });
      this.watcher.unref();
    } catch {
      this.watcher = null;
    }
    return this;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.dirty = true;
  }

  /** Read again when the mtime changes; no file is the empty allow list, which reads nothing. An unreadable or
   *  half-written file keeps the previous rules and is retried on the next call. */
  rules(): BlacklistRules {
    if (this.watcher !== null && !this.dirty) return this.current;
    let mtime: bigint;
    try {
      mtime = statSync(this.path, { bigint: true }).mtimeNs;
    } catch {
      this.mtime = null;
      this.current = EMPTY_BLACKLIST;
      this.dirty = false;
      return this.current;
    }
    if (mtime === this.mtime) {
      this.dirty = false;
      return this.current;
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return this.current;
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return this.current;
    this.current = parseBlacklist(json);
    this.mtime = mtime;
    this.dirty = false;
    return this.current;
  }
}
