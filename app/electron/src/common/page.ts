// One page document's bridge state: its subscriptions, route callbacks and
// picked file handles. Everything ends with the document; a push made for an ended one is dropped.

/** A stream event as the shim delivers it (protocol.ts `StreamEvent`). */
export interface StreamEvent { event: string; id: string | null; data: string }

/** Ends one subscription; after it neither of its callbacks runs again. */
export type Cancel = () => void;

/** A stream pages subscribe to. `afterSeq` is the event id the page has already read. */
export interface EventSource {
  subscribe(afterSeq: string | null, onEvent: (e: StreamEvent) => void, onReload: () => void): Cancel;
}

/** Sends one push to the page's shim (`installBridge`'s `listen`). */
export type PushTarget = (id: number, stream: string, kind: 'event' | 'reload', payload: StreamEvent | null) => void;

export class PageSession {
  /** Bumped when the document ends; pushes and replies made for an older one are dropped. */
  generation = 0;
  private readonly target: PushTarget;
  /** Keyed by `<stream> <id>`, the id the shim gave the subscription. */
  private subscriptions = new Map<string, Cancel>();
  private routeIds: number[] = [];
  /** The last route pushed while no document had subscribed; its next subscriber gets it. */
  private pendingRoute: string | null = null;
  /** The current document's unused `files.pick*` handles. */
  readonly picked = new Map<string, { purpose: string; path: string }>();

  constructor(target: PushTarget) {
    this.target = target;
  }

  push(generation: number, id: number, stream: string, kind: 'event' | 'reload', payload: StreamEvent | null): void {
    if (generation === this.generation) this.target(id, stream, kind, payload);
  }

  /** Replaces the subscription `<stream> <id>` with one on `source`; nothing when `generation` has ended. */
  subscribe(generation: number, stream: string, id: number, source: EventSource, afterSeq: string | null): void {
    if (generation !== this.generation) return;
    const key = `${stream} ${id}`;
    this.subscriptions.get(key)?.();
    this.subscriptions.set(key, source.subscribe(afterSeq,
      (e) => this.push(generation, id, stream, 'event', e),
      () => this.push(generation, id, stream, 'reload', null)));
  }

  unsubscribe(generation: number, stream: string, id: number): void {
    if (generation !== this.generation) return;
    const key = `${stream} ${id}`;
    this.subscriptions.get(key)?.();
    this.subscriptions.delete(key);
  }

  /** `window.onRoute`: the pending route, if any, goes to this subscriber at once. */
  onRoute(generation: number, id: number): void {
    if (generation !== this.generation) return;
    this.routeIds.push(id);
    if (this.pendingRoute !== null) {
      const route = this.pendingRoute;
      this.pendingRoute = null;
      this.push(generation, id, 'route', 'event', { event: 'route', id: null, data: route });
    }
  }

  /** Hands `route` (a hash route without `#`) to the document's `window.onRoute` callbacks, or keeps it for the next. */
  pushRoute(route: string): void {
    if (this.routeIds.length === 0) {
      this.pendingRoute = route;
      return;
    }
    for (const id of this.routeIds) this.push(this.generation, id, 'route', 'event', { event: 'route', id: null, data: route });
  }

  /** The document ended (navigation, reload or close): cancels every subscription. */
  end(): void {
    this.generation += 1;
    this.routeIds = [];
    this.picked.clear();
    const ended = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const cancel of ended) cancel();
  }
}
