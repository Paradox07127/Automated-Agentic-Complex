// What the renderer link hands agentd: `trace` events batched for `POST /trace/events`, behavior receipts to
// `POST /behavior/receipts` in the order she sent them, motion requests to `POST /motions/generate`.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Mark } from '../../common/turn-marks.ts';

/** Seconds for `flushAfter` and `tick`. */
export const TRACE_FORWARD = { batchSize: 200, flushAfter: 0.5, maxBuffered: 2000, tick: 0.05 } as const;

type Event = Record<string, unknown>;

/** C3 rule 22: batches T1 events, holding them while agentd is unreachable. */
export class TraceForwarder {
  private readonly epoch: number;
  private readonly send: (events: Event[]) => Promise<number>;
  private readonly clock: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private buffer: Event[] = [];
  /** When the oldest event waiting for the next batch entered the buffer. */
  private firstAt: number | null = null;
  /** After a failed send nothing goes out before this. */
  private retryAt = -Infinity;
  private sending = false;
  private dropped = 0;
  private droppedSince: string | null = null;
  private seq = 0;

  /** `epoch` is the `producer_epoch` of its own (`companion`) events; `send` resolves to the HTTP status, 0 on failure;
   *  `clock` is in seconds. */
  constructor(epoch: number, send: (events: Event[]) => Promise<number>, clock = () => Date.now() / 1000) {
    this.epoch = epoch;
    this.send = send;
    this.clock = clock;
    this.timer = setInterval(() => this.tick(), TRACE_FORWARD.tick * 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  add(events: Event[]): void {
    if (events.length === 0) return;
    this.firstAt ??= this.clock();
    this.buffer.push(...events);
    this.trim();
    if (this.buffer.length >= TRACE_FORWARD.batchSize) this.flush();
  }

  /** Queues its own (`companion`) event `kind` of turn `turnId` that happened at `at`. */
  emit(kind: string, traceId: string, turnId: string, generation: number, at: Mark): void {
    this.add([this.event(kind, traceId, turnId, generation, at, {})]);
  }

  tick(): void {
    if (this.firstAt !== null && this.clock() - this.firstAt >= TRACE_FORWARD.flushAfter) this.flush();
  }

  /** Drops the oldest events beyond `maxBuffered`, counting them for the next `trace.dropped`. */
  private trim(): void {
    const over = this.buffer.length - TRACE_FORWARD.maxBuffered;
    if (over <= 0) return;
    this.buffer.splice(0, over);
    if (this.dropped === 0) this.droppedSince = new Date(this.clock() * 1000).toISOString();
    this.dropped += over;
  }

  private flush(): void {
    if (this.sending || this.buffer.length === 0 || this.clock() < this.retryAt) return;
    const taken = this.buffer.splice(0, this.dropped > 0 ? TRACE_FORWARD.batchSize - 1 : TRACE_FORWARD.batchSize);
    const report = this.dropped > 0 ? { count: this.dropped, since: this.droppedSince ?? new Date(this.clock() * 1000).toISOString() } : null;
    this.dropped = 0;
    this.droppedSince = null;
    const batch = [...(report ? [this.droppedEvent(report.count, report.since)] : []), ...taken];
    this.firstAt = this.buffer.length === 0 ? null : this.clock();
    this.sending = true;
    void this.send(batch).catch(() => 0).then((status) => this.finished(status, taken, report));
  }

  private finished(status: number, taken: Event[], report: { count: number; since: string } | null): void {
    this.sending = false;
    if (status < 200 || status >= 300) {
      // The events go back in front in their order; the drop count is reported again with the next batch.
      this.buffer = [...taken, ...this.buffer];
      if (report) {
        this.dropped += report.count;
        this.droppedSince = report.since;
      }
      this.trim();
      this.firstAt ??= this.clock();
      this.retryAt = this.clock() + TRACE_FORWARD.flushAfter;
      return;
    }
    if (this.buffer.length >= TRACE_FORWARD.batchSize) this.flush();
  }

  /** Its own C6 §4.1 `trace.dropped` event. */
  private droppedEvent(count: number, since: string): Event {
    return this.event('trace.dropped', randomUUID(), null, null, { wall: this.clock(), monoMs: Math.floor(performance.now()) }, { count, since });
  }

  private event(kind: string, traceId: string, turnId: string | null, generation: number | null, at: Mark, attrs: Event): Event {
    this.seq += 1;
    return { v: 1, event_id: randomUUID(), trace_id: traceId, turn_id: turnId, turn_generation: generation,
      span_id: randomBytes(8).toString('hex'), parent_span_id: null, causation_id: null, producer: 'companion',
      producer_epoch: this.epoch, seq: this.seq, kind, t_wall: new Date(at.wall * 1000).toISOString(),
      t_mono_ms: at.monoMs, status: 'ok', attrs };
  }
}

export interface ForwardPorts {
  /** The TraceForwarder's `producer_epoch`: the app's launch in Unix ms. */
  epoch: number;
  /** A C6 POST; status 0 when it could not be made. */
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  /** The hostlink log. */
  log(line: string): void;
}

/** HostLink's `onTrace`, `onBehaviorReceipt` and `onMotionRequest`. */
export function agentdForwarding(o: ForwardPorts) {
  const trace = new TraceForwarder(o.epoch, async (events) => {
    const { status, body } = await o.post('/trace/events', { events });
    const rejected = (body as { rejected?: unknown } | null)?.rejected;
    if (Array.isArray(rejected) && rejected.length > 0) {
      o.log(`trace forward events=${events.length} rejected=${rejected.length} error=${String((rejected[0] as { error?: unknown } | null)?.error ?? '')}`);
    }
    if (status !== 200) o.log(`trace forward events=${events.length} status=${status}`);
    return status;
  });
  let tail: Promise<void> = Promise.resolve();
  return {
    onTrace: (events: Event[]) => trace.add(events),
    /** TurnMarks' emit: a `ui.*` mark of a line the shell handed to agentd. */
    mark: (kind: string, traceId: string, turnId: string, generation: number, at: Mark) => trace.emit(kind, traceId, turnId, generation, at),
    onBehaviorReceipt: (body: Event) => {
      tail = tail.then(async () => {
        const { status } = await o.post('/behavior/receipts', body);
        if (status !== 200) o.log(`behavior receipt forward behavior_id=${String(body.behavior_id ?? '')} status=${status}`);
      });
    },
    onMotionRequest: (body: Event) => {
      void o.post('/motions/generate', body).then(({ status }) => {
        if (status !== 202) o.log(`motion request forward request_id=${String(body.request_id ?? '')} status=${status}`);
      });
    },
    stop: () => trace.stop(),
  };
}
