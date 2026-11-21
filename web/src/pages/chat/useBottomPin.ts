import { useEffect, type DependencyList, type RefObject } from 'react';

/**
 * Scrolls the stream to the bottom when `deps` change, then keeps it there while turn tags, cards and the composer's
 * hint line arrive, until the user scrolls up. An open question (`[data-pending]`) takes the bottom's place: the stream
 * holds its card's top at the top until the user scrolls. `on` false (the turn tab owns the scroll) does neither.
 */
export function useBottomPin(scroller: RefObject<HTMLDivElement | null>, on: boolean, deps: DependencyList) {
  useEffect(() => {
    const el = scroller.current;
    if (!el || !on) return;
    let held = true;
    const place = () => {
      const card = held ? el.querySelector<HTMLElement>('[data-pending]') : null;
      el.scrollTop = card ? el.scrollTop + card.getBoundingClientRect().top - el.getBoundingClientRect().top - 8 : el.scrollHeight;
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    let pinned = true;
    // Our own scroll's event lands a frame later, after growth; only a position we did not set can unpin.
    let lastSet = el.scrollTop;
    let frame = 0;
    const onScroll = () => {
      if (el.scrollTop === lastSet) return;
      held = false;
      pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    };
    const ro = new ResizeObserver(() => {
      if (!pinned || frame) return;
      // Scrolling can move a sticky child and change overflow in WebKit. Write outside observer delivery.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pinned) return;
        place();
        lastSet = el.scrollTop;
      });
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('scroll', onScroll);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, [on, ...deps]);
}
