import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Scale that fits a `w`×`h` stage inside the box, `pad` px clear on each side, never below `min`; 1 until measured.
 * Also the box's width in stage px at that scale.
 */
export function useFit<T extends HTMLElement>(w: number, h: number, pad: number, min: number) {
  const ref = useRef<T>(null);
  const [fit, setFit] = useState({ k: 1, room: Infinity });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const s = Math.min((el.clientWidth - 2 * pad) / w, (el.clientHeight - 2 * pad) / h);
      if (s <= 0) return;
      const k = Math.max(Math.round(s * 1000) / 1000, min);
      const room = el.clientWidth / k;
      setFit((f) => (f.k === k && f.room === room ? f : { k, room }));
    };
    measure();
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
  }, [w, h, pad, min]);
  return [ref, fit.k, fit.room] as const;
}
