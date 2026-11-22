import { useEffect, useRef, useState } from 'react';
import type { SwapAsk } from './ConvDialogs';
import type { ChatCharacter } from './useChatData';

/** At this window width or narrower the topic column starts folded. */
const NARROW = '(max-width: 1000px)';

/** Whether the topic column is folded, and its toggle: the window width decides until the user folds or opens it. */
export function useFold() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const changed = () => setNarrow(mq.matches);
    mq.addEventListener('change', changed);
    return () => mq.removeEventListener('change', changed);
  }, []);
  // null: follows the window width.
  const [fold, setFold] = useState<boolean | null>(null);
  const folded = fold ?? narrow;
  return { folded, toggle: () => setFold(!folded), open: () => setFold(false) };
}

/** The swap card: `ask` shows it for `who` and settles with the user's answer. */
export function useSwapAsk(chars: ChatCharacter[], present: string | null) {
  const [swapAsk, setSwapAsk] = useState<SwapAsk | null>(null);
  const settle = useRef<((yes: boolean) => void) | null>(null);
  const ask = (who: ChatCharacter, text: string) =>
    new Promise<boolean>((resolve) => {
      settle.current = resolve;
      setSwapAsk({ who, from: chars.find((c) => c.id === present) ?? null, text });
    });
  const answer = (yes: boolean) => {
    settle.current?.(yes);
    settle.current = null;
    setSwapAsk(null);
  };
  return { swapAsk, ask, answer };
}
