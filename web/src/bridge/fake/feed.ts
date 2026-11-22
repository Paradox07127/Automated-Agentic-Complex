import type { StreamEvent, Unsubscribe } from '../protocol';

export interface ScriptedEvent {
  /** Delay after the previous event, in ms. */
  delay: number;
  event: string;
  data: unknown;
  /** Sent instead of this event when the script is stopped before it. */
  cut?: unknown;
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

const REPLIES: Record<string, string> = { si: '嗯，收到啦。我记下了，等会儿就去办，办好了再来叫你。' };

/** What a character answers to any line. */
export const replyText = (character_id: string): string => REPLIES[character_id] ?? '好，我记下了。';

/** Her reply to a line the fake agentd took: `line` frames of a few deltas, then the final one (turns.py line event). */
export function replyScript({ character_id, ...line }: { line_id: string; conversation_id: string; character_id: string }): ScriptedEvent[] {
  const text = replyText(character_id);
  const parts = text.match(/[^，。！？]+[，。！？]?/g) ?? [text];
  const frame = (text_delta: string, final: boolean, cancelled = false) => ({ ...line, run_id: line.line_id, text_delta, final, intents: [], cancelled, error: null, lane: 'character' });
  return [...parts.map((p) => ({ delay: 400, event: 'line', data: frame(p, false) })), { delay: 300, event: 'line', data: frame('', true), cut: frame('', true, true) }];
}

/** Plays the script once; `still` plays nothing. The returned stop cancels what has not played and reports whether it cut the script short. */
export function playOnce(script: ScriptedEvent[], still: boolean, onEvent: (e: StreamEvent) => void): () => boolean {
  if (still) return () => false;
  let wait = 0;
  let played = 0;
  const timers = script.map((item, i) => {
    wait += item.delay;
    return setTimeout(() => {
      played = i + 1;
      onEvent({ event: item.event, id: `reply-${i}`, data: JSON.stringify(item.data) });
    }, wait);
  });
  return () => {
    if (played === script.length) return false;
    timers.forEach(clearTimeout);
    const cut = script.slice(played).find((item) => item.cut !== undefined);
    if (cut) onEvent({ event: cut.event, id: 'reply-cut', data: JSON.stringify(cut.cut) });
    played = script.length;
    return true;
  };
}
