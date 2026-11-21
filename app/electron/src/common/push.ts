// A stream the shell pushes to the desktop pages. With `replay` a new subscriber gets the last value
// at once and repeats are dropped; without it each value goes out once, to the subscribers there are (commands).
import type { Cancel, EventSource, StreamEvent } from './page.ts';

/** JSON with object keys sorted, so equal values compare equal. */
function sorted(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

export class PushSource implements EventSource {
  private readonly event: string;
  private readonly replay: boolean;
  private readonly volatile: ReadonlySet<string>;
  private readonly subscribers = new Set<(e: StreamEvent) => void>();
  private current: string | null = null;
  /** `current` without the volatile keys. */
  private shown: string | null = null;

  /** `volatile`: top-level keys of an object value that change on every read; with `replay`, a value that differs from the
   *  last one only in them replaces it for replay but is not sent. */
  constructor(event: string, options: { replay?: boolean; volatile?: string[] } = {}) {
    this.event = event;
    this.replay = options.replay ?? true;
    this.volatile = new Set(options.volatile ?? []);
  }

  subscribe(_afterSeq: string | null, onEvent: (e: StreamEvent) => void): Cancel {
    this.subscribers.add(onEvent);
    if (this.replay && this.current !== null) onEvent({ event: this.event, id: null, data: this.current });
    return () => { this.subscribers.delete(onEvent); };
  }

  /** `value` is any JSON value. */
  send(value: unknown): void {
    const data = sorted(value);
    if (this.replay) {
      const object = this.volatile.size > 0 && value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      const shown = object ? sorted(Object.fromEntries(Object.entries(object).filter(([k]) => !this.volatile.has(k)))) : data;
      this.current = data;
      if (shown === this.shown) return;
      this.shown = shown;
    }
    for (const s of [...this.subscribers]) s({ event: this.event, id: null, data });
  }
}
