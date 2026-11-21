// The T1 `ui.submitted`, `ui.ack` and `ui.first_text` of the lines the shell hands to agentd's `POST /say`.
import type { StreamEvent } from './page.ts';

/** Unix seconds and monotonic milliseconds of one moment. */
export interface Mark { wall: number; monoMs: number }

export const markNow = (): Mark => ({ wall: Date.now() / 1000, monoMs: Math.floor(performance.now()) });

/** kind, trace_id, turn_id (the line id), turn_generation, moment. */
export type MarkEmit = (kind: string, traceId: string, turnId: string, generation: number, at: Mark) => void;

export class TurnMarks {
  static readonly maxWaiting = 32;
  private readonly emit: MarkEmit;
  private readonly now: () => Mark;
  /** Accepted lines waiting for their first text, oldest first. */
  private waiting: { lineId: string; traceId: string; generation: number }[] = [];

  constructor(emit: MarkEmit, now: () => Mark = markNow) {
    this.emit = emit;
    this.now = now;
  }

  /** agentd's 202 for `lineId` arrived now; `traceId` or `generation` null (an agentd that does not send it) marks nothing. */
  accepted(lineId: string, traceId: string | null, generation: number | null, submittedAt: Mark): void {
    if (traceId === null || generation === null) return;
    this.emit('ui.submitted', traceId, lineId, generation, submittedAt);
    this.emit('ui.ack', traceId, lineId, generation, this.now());
    this.waiting.push({ lineId, traceId, generation });
    if (this.waiting.length > TurnMarks.maxWaiting) this.waiting.shift();
  }

  /** A `/feed` `line` delta of `lineId` arrived now. */
  line(lineId: string, hasText: boolean): void {
    const index = hasText ? this.waiting.findIndex((w) => w.lineId === lineId) : -1;
    if (index < 0) return;
    const [entry] = this.waiting.splice(index, 1);
    this.emit('ui.first_text', entry!.traceId, lineId, entry!.generation, this.now());
  }

  /** A feed event, of which only `line` counts. */
  feed(e: StreamEvent): void {
    if (e.event !== 'line') return;
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    const line = data as { line_id?: unknown; text_delta?: unknown } | null;
    if (typeof line?.line_id === 'string' && typeof line.text_delta === 'string') this.line(line.line_id, line.text_delta !== '');
  }

  /** A 202 body of `POST /say` (or `/conversations/:id/messages`) sent at `submittedAt`. */
  acceptedBody(status: number, body: Record<string, unknown> | null, submittedAt: Mark): void {
    if (status !== 202 || typeof body?.line_id !== 'string') return;
    this.accepted(body.line_id, typeof body.trace_id === 'string' ? body.trace_id : null,
      Number.isInteger(body.generation) ? body.generation as number : null, submittedAt);
  }
}
