// `<support>/logs/error.jsonl`: one JSON line per error the shell sees, with a stable `code` (docs/architecture/shell.md
// 「错误记录」), and repeats within a minute folded into a count. No prompt text, tool input, op arguments or secrets.

export type ErrorComponent = 'shell' | 'renderer-link' | 'bridge' | 'page' | 'agentd' | 'host' | 'helper' | 'tts';

/** Every `code` a record may carry, and what its `message` is; a writer uses only these. */
export const ERROR_CODES = {
  op_failed: 'a bridge op answered the page with an error: `<op> <bridge code>`, `req` the op',
  host_exit: 'the renderer exited on its own: `status=<n>` or `signal=<name>`, `detail` its last `error:` line',
  host_message_rejected: 'the host link dropped a C3 message against the contract: `type=<type> why=<field or reason>`',
  permission_denied: 'the helper lacks a system grant: `<grant> <op>`, `req` the op',
  page_exception: 'a page threw: `[<route>: ]<error>`, `detail` its first component frame or its source',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorInput {
  component: ErrorComponent;
  code: ErrorCode;
  message: string;
  detail?: string;
  turn_id?: string;
  trace_id?: string;
  req?: string;
}

/** One line of error.jsonl: `t` ISO time, `count` how many of these the line stands for. */
export interface ErrorRecord extends ErrorInput {
  t: string;
  count: number;
}

/** `windowMs`: repeats of a (component, code, message) within it fold into one count line; message and detail are cut to these. */
export const ERROR_LOG = { windowMs: 60_000, maxMessage: 300, maxDetail: 500 } as const;

const cut = (text: string, max: number) => [...text].slice(0, max).join('');

/** The first occurrence of a (component, code, message) is written at once; its repeats are one line with their count when
 *  its minute is over, and while they go on, one line a minute. `flush` is to be called at least once a minute. */
export class ErrorLog {
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly open = new Map<string, { start: number; repeats: number; last: ErrorInput; lastAt: number }>();

  constructor(write: (line: string) => void, now: () => number = Date.now) {
    this.write = write;
    this.now = now;
  }

  record(input: ErrorInput): void {
    const at = this.now();
    this.flush();
    const e: ErrorInput = { ...input, message: cut(input.message, ERROR_LOG.maxMessage),
      ...(input.detail !== undefined && { detail: cut(input.detail, ERROR_LOG.maxDetail) }) };
    const key = `${e.component}\u0000${e.code}\u0000${e.message}`;
    const held = this.open.get(key);
    if (held) {
      held.repeats += 1;
      held.last = e;
      held.lastAt = at;
      return;
    }
    this.open.set(key, { start: at, repeats: 0, last: e, lastAt: at });
    this.line(e, at, 1);
  }

  /** Writes the count of each minute that is over (every one with `all`, as at quit). */
  flush(all = false): void {
    const at = this.now();
    for (const [key, held] of this.open) {
      if (!all && at - held.start < ERROR_LOG.windowMs) continue;
      if (held.repeats === 0 || all) this.open.delete(key);
      if (held.repeats === 0) continue;
      this.line(held.last, held.lastAt, held.repeats);
      held.start = at;
      held.repeats = 0;
    }
  }

  private line(e: ErrorInput, at: number, count: number): void {
    const r: ErrorRecord = { t: new Date(at).toISOString(), component: e.component, code: e.code, message: e.message,
      ...(e.detail !== undefined && { detail: e.detail }), ...(e.turn_id !== undefined && { turn_id: e.turn_id }),
      ...(e.trace_id !== undefined && { trace_id: e.trace_id }), ...(e.req !== undefined && { req: e.req }), count };
    this.write(`${JSON.stringify(r)}\n`);
  }
}

/** At most one log line a minute per key: the first at once; the repeats within its minute are counted onto the next line
 *  that goes out. */
export class LineLimiter {
  private readonly seen = new Map<string, { at: number; skipped: number }>();

  /** The line to write now, or null. `now` in ms. */
  pass(key: string, line: string, now: number): string | null {
    const s = this.seen.get(key);
    if (s && now - s.at < ERROR_LOG.windowMs) {
      s.skipped += 1;
      return null;
    }
    this.seen.set(key, { at: now, skipped: 0 });
    return s && s.skipped > 0 ? `${line} (+${s.skipped} more)` : line;
  }
}
