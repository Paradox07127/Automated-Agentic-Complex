import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../bridge';

/**
 * Hover for timers that pause under the pointer (life line, delivery 20 s). A non-key panel gets no mouse events,
 * so the native pointer push is hit-tested too.
 */
export function useHover<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [mouse, setMouse] = useState(false);
  const [pointer, setPointer] = useState(false);

  useEffect(
    () =>
      getBridge().window.onPointer((p) => {
        const r = ref.current?.getBoundingClientRect();
        const inside = !!r && p.inside && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
        setPointer((prev) => (prev === inside ? prev : inside));
      }),
    [],
  );

  return {
    ref,
    hovered: mouse || pointer,
    handlers: { onMouseEnter: () => setMouse(true), onMouseLeave: () => setMouse(false) },
  };
}
