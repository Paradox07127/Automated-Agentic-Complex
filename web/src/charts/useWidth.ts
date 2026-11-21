import { useLayoutEffect, useRef, useState } from 'react';

/** Rendered width of a box, so an SVG can use a 1:1 viewBox and keep its text at the token size; `fallback` until measured. */
export function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    measure();
    // Re-rendering inside the observer's callback resizes the box again in the same frame (a ResizeObserver loop error).
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);
  return [ref, width] as const;
}
