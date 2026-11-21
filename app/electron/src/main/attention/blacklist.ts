// `<agentd_state_dir>/blacklist.json` for the attention heartbeat.
import { readFileSync, statSync } from 'node:fs';
import { type BlacklistRules, EMPTY_BLACKLIST, parseBlacklist } from '../../common/attention.ts';

export class BlacklistFile {
  private readonly path: string;
  private mtime: bigint | null = null;
  private current: BlacklistRules = EMPTY_BLACKLIST;

  constructor(path: string) {
    this.path = path;
  }

  /** Read again when the mtime changes; no file is the empty allow list, which reads nothing. An unreadable or
   *  half-written file keeps the previous rules and is retried on the next call. */
  rules(): BlacklistRules {
    let mtime: bigint;
    try {
      mtime = statSync(this.path, { bigint: true }).mtimeNs;
    } catch {
      this.mtime = null;
      this.current = EMPTY_BLACKLIST;
      return this.current;
    }
    if (mtime === this.mtime) return this.current;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return this.current;
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return this.current;
    this.current = parseBlacklist(json);
    this.mtime = mtime;
    return this.current;
  }
}
