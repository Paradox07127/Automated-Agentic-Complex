// The main process's half of C12 (protocol/C12-platform-helper): NDJSON requests to the platform helper, their answers
// and the helper's events, the per-op timeouts with `cancel`, and the checks that make the helper count as broken.
import spec from '../../../../../protocol/C12-platform-helper/ops.json' with { type: 'json' };

export const PROTOCOL = spec.protocol;
export const MAX_LINE_BYTES = spec.max_line_bytes;

export interface HelperError { code: string; message: string; retryable?: boolean }
export type HelperReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: HelperError };
export interface HelperEvent { event: string; seq: number; data: Record<string, unknown> }

const OPS = spec.ops as Record<string, { timeout_ms: number }>;

/** The op's `timeout_ms` of ops.json; ops this build does not know get the longest session op's. */
export function timeoutMs(op: string): number {
  return OPS[op]?.timeout_ms ?? OPS.hello!.timeout_ms;
}

/** CONTRACT §3: the main process's own errors, which never come from the helper. */
export function localError(code: 'helper_exited' | 'helper_timeout' | 'protocol_error', message: string): HelperReply {
  return { ok: false, error: { code, message } };
}

/** The same op this many times in a row without an answer in time: the helper is stuck (CONTRACT §5.1). */
export const STUCK_TIMEOUTS = 3;

export interface ConnectionOptions {
  write: (line: string) => void;
  /** An illegal message or a stuck helper (CONTRACT §6.3); the connection is dead after it. */
  onBroken: (reason: string) => void;
  onEvent?: (event: HelperEvent) => void;
  /** Multiplies every timeout; tests shorten them. */
  timeScale?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One helper process's session: ids, answers, timeouts and events. */
export class HelperConnection {
  private readonly options: ConnectionOptions;
  private lastId = 0;
  /** The last event's seq; the helper counts from 1 (CONTRACT §2.6). */
  private lastSeq = 0;
  private readonly pending = new Map<number, { op: string; resolve: (r: HelperReply) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Requests that timed out or were given up; their late answers are dropped. */
  private readonly abandoned = new Set<number>();
  private readonly timeouts = new Map<string, number>();
  private buffer: Buffer = Buffer.alloc(0);
  private events: ReadonlySet<string> = new Set();
  private broken = false;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  /** The events `hello` listed; any other event is illegal. */
  set helloEvents(events: readonly string[]) {
    this.events = new Set(events);
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /** `signal`'s abort sends `cancel` for this request; the request still settles with the helper's own answer to it. */
  request(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<HelperReply> {
    if (this.broken) return Promise.resolve(localError('helper_exited', 'the helper is not running'));
    const id = ++this.lastId;
    const line = `${JSON.stringify({ v: 1, id, op, params })}\n`;
    // The helper ends itself on a longer line (CONTRACT §2.2), so the request goes no further than here.
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return Promise.resolve<HelperReply>({ ok: false, error: { code: 'bad_request', message: 'the request is longer than max_line_bytes' } });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.timedOut(id), timeoutMs(op) * (this.options.timeScale ?? 1));
      const cancel = () => void this.request('cancel', { target: id });
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { op, timer, resolve: (r) => {
        signal?.removeEventListener('abort', cancel);
        resolve(r);
      } });
      this.options.write(line);
    });
  }

  /** stdout bytes as they come. */
  feed(chunk: Buffer): void {
    if (this.broken) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (let newline = this.buffer.indexOf(0x0a); newline !== -1 && !this.broken; newline = this.buffer.indexOf(0x0a)) {
      if (newline + 1 > MAX_LINE_BYTES) return this.fail('a line is longer than max_line_bytes');
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      this.line(line);
    }
    if (this.buffer.length >= MAX_LINE_BYTES) this.fail('a line is longer than max_line_bytes');
  }

  /** Answers every request in flight with `reply` and takes no more: the helper is gone. */
  close(reply: HelperReply): void {
    this.broken = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(reply);
    }
  }

  private line(line: string): void {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.fail('a line is not JSON');
    }
    if (!isObject(message) || message.v !== 1) return this.fail('a message has no "v": 1');
    if ('ok' in message && !('event' in message) && !('op' in message)) return this.answer(message);
    if ('event' in message && !('ok' in message) && !('op' in message)) {
      const { event, seq, data } = message;
      if (typeof event !== 'string' || !this.events.has(event)) return this.fail('an event that hello did not list');
      if (!Number.isInteger(seq) || !isObject(data)) return this.fail('an event without seq or data');
      if ((seq as number) <= this.lastSeq) return this.fail('an event whose seq does not increase');
      this.lastSeq = seq as number;
      this.options.onEvent?.({ event, seq: seq as number, data });
      return;
    }
    this.fail('a message that is neither an answer nor an event');
  }

  private answer(message: Record<string, unknown>): void {
    const id = message.id as number;
    const p = this.pending.get(id);
    if (!p) {
      if (this.abandoned.delete(id)) return;
      return this.fail('an answer to no request in flight');
    }
    let reply: HelperReply;
    if (message.ok === true && isObject(message.result)) reply = { ok: true, result: message.result };
    else if (message.ok === false && isObject(message.error) && typeof message.error.code === 'string') {
      reply = { ok: false, error: message.error as unknown as HelperError };
    } else return this.fail('an answer without result or error');
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.timeouts.delete(p.op);
    p.resolve(reply);
  }

  private timedOut(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.abandoned.add(id);
    p.resolve(localError('helper_timeout', `${p.op} had no answer in time`));
    const count = (this.timeouts.get(p.op) ?? 0) + 1;
    this.timeouts.set(p.op, count);
    if (count >= STUCK_TIMEOUTS) return this.fail(`${p.op} timed out ${count} times in a row`);
    // The helper still answers the target once, as `cancelled` or with what it had; that late answer is dropped.
    if (p.op !== 'cancel') void this.request('cancel', { target: id });
  }

  private fail(reason: string): void {
    if (this.broken) return;
    this.close(localError('protocol_error', reason));
    this.options.onBroken(reason);
  }
}
