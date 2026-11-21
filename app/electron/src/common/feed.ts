// The event sources pages subscribe to: `/feed` with replay and `/diag/stream` shared by its subscribers.
import type { Cancel, EventSource, StreamEvent } from './page.ts';

/** The app's one `/feed` follower (AgentStore): every event, and a reload after each `gap` or `reset`. */
export interface EventFeed {
  subscribe(onEvent: (e: StreamEvent) => void): Cancel;
  onReload(onReload: () => void): Cancel;
}

/** `<stream_epoch>-<seq>`; the epoch may itself contain `-`. */
export function parseEventId(id: string): { epoch: string; seq: number } | null {
  const dash = id.lastIndexOf('-');
  if (dash < 0 || !/^[+-]?\d+$/.test(id.slice(dash + 1))) return null;
  return { epoch: id.slice(0, dash), seq: Number(id.slice(dash + 1)) };
}

/** `stream_epoch` and `latest_seq` of a `stream` or `reset`. */
function edge(e: StreamEvent): { epoch: string; seq: number } | null {
  try {
    const o = JSON.parse(e.data) as Record<string, unknown> | null;
    if (o && typeof o.stream_epoch === 'string' && Number.isInteger(o.latest_seq)) return { epoch: o.stream_epoch, seq: o.latest_seq as number };
  } catch { /* not JSON */ }
  return null;
}

/** `/feed` for pages: the feed's events, with the latest ones kept to replay to a page that subscribes after it read its
 *  snapshot. */
export class FeedSource implements EventSource {
  static readonly replayLimit = 512;
  private readonly feed: EventFeed;
  private buffer: { epoch: string; seq: number; event: StreamEvent }[] = [];
  /** null until the feed has handed out an event that names one. */
  private epoch: string | null = null;
  /** Where the last `gap` or `reset` cleared the buffer; a page at or before it has missed events. */
  private cleared: { epoch: string; seq: number } | null = null;

  /** Subscribes to `feed` before any page does, so an event is buffered before a page is handed it. */
  constructor(feed: EventFeed) {
    this.feed = feed;
    feed.subscribe((e) => this.keep(e));
  }

  /** With `afterSeq` in the stream's epoch and not older than the buffer's first event, replays the buffered events after
   *  it; with the buffer empty since a `gap` or `reset`, `afterSeq` must be after where it was cleared. Otherwise calls
   *  `onReload` once. Before the feed has handed out any event, live events only. */
  subscribe(afterSeq: string | null, onEvent: (e: StreamEvent) => void, onReload: () => void): Cancel {
    const after = afterSeq === null ? null : parseEventId(afterSeq);
    if (afterSeq !== null && !this.replay(after, onEvent)) onReload();
    const events = this.feed.subscribe((e) => {
      // The page already has every event of its epoch up to `afterSeq`, even those the buffer has not seen yet.
      const seen = e.id === null ? null : parseEventId(e.id);
      if (after && seen && seen.epoch === after.epoch && seen.seq <= after.seq) return;
      onEvent(e);
    });
    const reloads = this.feed.onReload(onReload);
    return () => {
      events();
      reloads();
    };
  }

  /** false when the page has missed events the buffer does not hold. */
  private replay(after: { epoch: string; seq: number } | null, onEvent: (e: StreamEvent) => void): boolean {
    if (this.epoch === null) return true;
    if (!after || after.epoch !== this.epoch) return false;
    const oldest = this.buffer[0];
    if (oldest) {
      if (oldest.epoch !== this.epoch || after.seq < oldest.seq) return false;
      for (const b of this.buffer) if (b.epoch === this.epoch && b.seq > after.seq) onEvent(b.event);
      return true;
    }
    if (!this.cleared || this.cleared.epoch !== this.epoch) return true;
    return after.seq > this.cleared.seq;
  }

  /** The feed hands a `gap` or `reset` to subscribers before it asks them to reload. */
  private keep(e: StreamEvent): void {
    if (e.event === 'gap') {
      const last = this.buffer.at(-1);
      if (last) this.cleared = { epoch: last.epoch, seq: last.seq };
      this.buffer = [];
    } else if (e.event === 'reset') {
      const found = edge(e);
      if (found) {
        this.epoch = found.epoch;
        this.cleared = found;
      }
      this.buffer = [];
    } else if (e.event === 'stream') {
      const found = edge(e);
      if (found) this.epoch = found.epoch;
    }
    const parsed = e.id === null ? null : parseEventId(e.id);
    if (!parsed) return;
    this.epoch = parsed.epoch;
    this.buffer.push({ ...parsed, event: e });
    if (this.buffer.length > FeedSource.replayLimit) this.buffer.shift();
  }
}

/** A stream without replay shared by its subscribers: `start` connects with the first, `stop` disconnects after the
 *  last is cancelled. `afterSeq` is ignored and `onReload` never called. */
export class SharedSource implements EventSource {
  private readonly start: (emit: (e: StreamEvent) => void) => void;
  private readonly stop: () => void;
  private subscribers: { id: number; onEvent: (e: StreamEvent) => void }[] = [];
  private lastId = 0;

  constructor(start: (emit: (e: StreamEvent) => void) => void, stop: () => void) {
    this.start = start;
    this.stop = stop;
  }

  subscribe(_afterSeq: string | null, onEvent: (e: StreamEvent) => void): Cancel {
    const id = ++this.lastId;
    this.subscribers.push({ id, onEvent });
    if (this.subscribers.length === 1) this.start((e) => { for (const s of [...this.subscribers]) s.onEvent(e); });
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      this.subscribers = this.subscribers.filter((s) => s.id !== id);
      if (this.subscribers.length === 0) this.stop();
    };
  }
}

/** A source with nothing to send yet: subscriptions are accepted and never called. */
export const silentSource: EventSource = { subscribe: () => () => {} };
