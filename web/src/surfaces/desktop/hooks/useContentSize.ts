import { useEffect, type RefObject } from 'react';
import { getBridge } from '../../../bridge';

/** A size within this many px of the last one sent is not reported, so sub-pixel layout jitter does not resize the panel. */
export const CONTENT_SIZE_STEP = 2;

/** Reports the element's size as the panel's content size whenever it changes; native sizes the panel to it. */
export function useContentSize(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bridge = getBridge();
    let sent: { width: number; height: number } | null = null;
    const report = () => {
      const r = el.getBoundingClientRect();
      const size = { width: Math.round(r.width), height: Math.round(r.height) };
      if (sent && Math.abs(size.width - sent.width) < CONTENT_SIZE_STEP && Math.abs(size.height - sent.height) < CONTENT_SIZE_STEP) return;
      sent = size;
      bridge.window.setContentSize(size);
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}
