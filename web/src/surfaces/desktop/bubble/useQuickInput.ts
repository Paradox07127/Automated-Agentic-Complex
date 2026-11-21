import { useEffect, useRef, useState } from 'react';
import { getBridge, type SayReplyTo } from '../../../bridge';
import { useAttachment, type Attachment } from '../cmd/input/selection';
import { why } from './useThoughtMute';

/** One unfolding of 快速输入; `n` counts them, so each open starts its box afresh. */
export interface OpenInput {
  n: number;
  prefill?: string;
  /** The bubble line 回复 quotes. */
  quote?: string;
  /** The line or thought 回复 answers. */
  replyTo?: SayReplyTo;
}

/**
 * 快速输入 under the bubble: native's `{kind:'open', mode:'input'}` unfolds it with the selection or scope
 * sent just before; esc or a sent line folds it and hands the key back. The attachment stays until ✕ or a sent line.
 */
export function useQuickInput() {
  const attachment = useAttachment();
  const [dropped, setDropped] = useState<Attachment | null>(null);
  const [open, setOpen] = useState<OpenInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opens = useRef(0);

  useEffect(
    () =>
      getBridge().desktop.onCommand((c) => {
        if (c.kind !== 'open' || c.mode !== 'input') return;
        const n = (opens.current += 1);
        setError(null);
        setOpen((o) => ({ n, prefill: c.prefill, quote: o?.quote, replyTo: o?.replyTo }));
      }),
    [],
  );

  return {
    open,
    error,
    attachment: attachment === dropped ? null : attachment,
    drop: () => setDropped(attachment),
    /** Unfolds it here at once, quoting `quote` as an answer to `replyTo`, and asks native for the key. */
    reply: (quote: string, replyTo?: SayReplyTo) => {
      const n = (opens.current += 1);
      setError(null);
      setOpen({ n, quote, replyTo });
      void getBridge().desktop.action('quickInput').catch((failure: unknown) => {
        if (opens.current === n) setError(why(failure));
      });
    },
    close: (sent: boolean) => {
      getBridge().window.releaseKey();
      if (sent) setDropped(attachment);
      opens.current += 1;
      setError(null);
      setOpen(null);
    },
  };
}
