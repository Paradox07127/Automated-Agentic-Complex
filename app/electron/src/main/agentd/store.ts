// The app's one `GET /feed` connection: its connection state for `agentd.connection`, every event for
// the pages' `feed.subscribe`, and a reload after each `gap` or `reset`.
import { Backoff } from '../../common/agentd.ts';
import { feedStreamEdge } from '../../common/c6.ts';
import type { EventFeed } from '../../common/feed.ts';
import type { Cancel, StreamEvent } from '../../common/page.ts';
import { AgentdClient, FeedStatusError, sleep } from './client.ts';

export type Connection = 'offline' | 'connected' | 'unauthorized';

export class AgentStore implements EventFeed {
  connection: Connection = 'offline';
  private readonly client: AgentdClient;
  private readonly retryDelay: (failures: number) => number;
  private readonly log: (line: string) => void;
  /** `<stream_epoch>-<seq>` to resume after; undefined until a connection names one. */
  private lastEventID: string | undefined;
  private subscribers = new Map<number, (e: StreamEvent) => void>();
  private reloads = new Map<number, () => void>();
  private lastId = 0;
  private abort: AbortController | undefined;

  /** `retryDelay(n)` is the wait in ms after the n-th failure in a row; `log` gets a subscriber's or reload's throw. */
  constructor(runtimePath: string, retryDelay = (n: number) => Backoff.delay(n) * 1000,
    log: (line: string) => void = (line) => console.error(line)) {
    this.client = new AgentdClient(runtimePath);
    this.retryDelay = retryDelay;
    this.log = log;
  }

  subscribe(onEvent: (e: StreamEvent) => void): Cancel {
    const id = ++this.lastId;
    this.subscribers.set(id, onEvent);
    return () => { this.subscribers.delete(id); };
  }

  onReload(onReload: () => void): Cancel {
    const id = ++this.lastId;
    this.reloads.set(id, onReload);
    return () => { this.reloads.delete(id); };
  }

  /** While not connected, connects again now with the failures counted from zero. */
  start(): void {
    if (this.abort && this.connection === 'connected') return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    void this.run(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.connection = 'offline';
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const resume = this.lastEventID;
      try {
        await this.client.stream('/feed', resume, signal, (e) => this.receive(e, resume !== undefined), () => {
          failures = 0;
          this.connection = 'connected';
        });
      } catch (e) {
        if (e instanceof FeedStatusError && (e.status === 401 || e.status === 403)) {
          if (signal.aborted) return;
          this.connection = 'unauthorized';
          this.abort = undefined;
          return;
        }
      }
      if (signal.aborted) return;
      this.connection = 'offline';
      failures += 1;
      await sleep(this.retryDelay(failures), signal);
    }
  }

  private receive(e: { event: string; id?: string; data: string }, cursorSent: boolean): void {
    if (e.id !== undefined) this.lastEventID = e.id;
    const found = feedStreamEdge(e, cursorSent);
    if (found !== undefined) this.lastEventID = found;
    const event: StreamEvent = { event: e.event, id: e.id ?? null, data: e.data };
    // One handler's throw reaches neither the others nor the stream.
    const call = (what: string, f: () => void) => {
      try {
        f();
      } catch (err) {
        this.log(`feed ${what} threw on ${e.event}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    for (const handler of [...this.subscribers.values()]) call('subscriber', () => handler(event));
    if (e.event === 'gap' || e.event === 'reset') for (const handler of [...this.reloads.values()]) call('reload', handler);
  }
}
