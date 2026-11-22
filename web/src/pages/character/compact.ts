import { createContext, useContext, useLayoutEffect, useState, type RefObject } from 'react';

const Compact = createContext(false);

/** Set by the detail panel: its rows and controls take their compact size. */
export const CompactProvider = Compact.Provider;

export const useCompact = () => useContext(Compact);

/**
 * True while the scene `ref` sits in is in its compact layout (925 × 515 and alike), the same limits as the
 * `@container op (max-width: 1100px)` and `(max-height: 560px)` rules; a scene not laid out yet (0 × 0) is not compact.
 */
export function useCompactScene(ref: RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(false);
  useLayoutEffect(() => {
    const scene = ref.current?.closest<HTMLElement>('[data-view="operator"]');
    if (!scene) return;
    const read = () => {
      const r = scene.getBoundingClientRect();
      setOn(r.width + r.height > 0 && (r.width <= 1100 || r.height <= 560));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(scene);
    return () => ro.disconnect();
  }, [ref]);
  return on;
}
