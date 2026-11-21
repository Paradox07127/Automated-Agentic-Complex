import type { StreamEvent, Unsubscribe } from '../protocol';

export interface ScriptedEvent {
  /** Delay after the previous event, in ms. */
  delay: number;
  event: string;
  data: unknown;
}

export const feedScript: ScriptedEvent[] = [
  { delay: 1500, event: 'run.progress', data: { runId: 'run-0142', step: 2, of: 5 } },
  { delay: 2500, event: 'approval.created', data: { id: 'apv-32', runId: 'run-0142', kind: 'file_write' } },
  { delay: 3000, event: 'run.progress', data: { runId: 'run-0142', step: 3, of: 5 } },
  { delay: 4000, event: 'presence.changed', data: { observing: true, app: 'Safari' } },
];

/** Plays the script in a loop; `still` freezes the feed (no events at all). */
export function scriptedStream(script: ScriptedEvent[], still: boolean, onEvent: (e: StreamEvent) => void): Unsubscribe {
  if (still || script.length === 0) return () => {};
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    const item = script[seq % script.length];
    if (!item) return;
    timer = setTimeout(() => {
      seq += 1;
      onEvent({ event: item.event, id: String(seq), data: JSON.stringify(item.data) });
      next();
    }, item.delay);
  };
  next();
  return () => clearTimeout(timer);
}
