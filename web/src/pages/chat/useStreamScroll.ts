import { useEffect, type RefObject } from 'react';
import type { WireTurn } from '../../domain';
import { useBottomPin } from './useBottomPin';

/** The stream rests at the bottom, or, when a link names a turn (`aim`) of the pages read so far, on that turn's reply (the one marked `data-sel`). */
export function useStreamScroll(scroller: RefObject<HTMLDivElement | null>, aim: string | null, wire: WireTurn[], conv: string | null) {
  const aimed = aim != null && wire.some((t) => t.turn_id === aim);
  useBottomPin(scroller, !aimed, [conv]);
  useEffect(() => {
    const box = scroller.current;
    const mark = box?.querySelector<HTMLElement>('[data-kind="ai"][data-sel]');
    if (box && mark) box.scrollTop += mark.getBoundingClientRect().top - box.getBoundingClientRect().top - (box.clientHeight - mark.offsetHeight) / 2;
  }, [aimed, conv]);
}
