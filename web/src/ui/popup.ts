import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const EDGE = 8;
const GAP = 4;
const MAX_H = 320;

/** Fixed-position box for a popup of `w`×`h` next to the trigger rect `r`: below unless only above has room, then flipped sideways when it overflows. */
export function placePopup(r: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>, w: number, h: number, align: 'left' | 'right', max = MAX_H): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = vh - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const up = Math.min(h, max) > below && above > below;
  let left = align === 'right' ? r.right - w : r.left;
  if (align === 'left' && left + w > vw - EDGE) left = r.right - w;
  else if (align === 'right' && left < EDGE) left = r.left;
  left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
  const maxHeight = Math.max(0, Math.min(max, up ? above : below));
  return up ? { left, bottom: vh - r.top + GAP, maxHeight } : { left, top: r.bottom + GAP, maxHeight };
}

/**
 * Where an open popup renders: the catalog's [data-modal-inline] figures show it in place; elsewhere it is portalled to
 * document.body, where no ancestor's overflow, isolation or z-index clips or covers it. There it keeps the trigger's theme
 * and `place` re-runs through scrolling and resizing.
 */
export function usePopupLayer(open: boolean, root: RefObject<HTMLElement | null>, place: () => CSSProperties | null) {
  const [inline, setInline] = useState<boolean>();
  const [layer, setLayer] = useState<{ theme?: string; place: CSSProperties }>();

  useLayoutEffect(() => {
    setInline(!!root.current?.closest('[data-modal-inline]'));
  }, [root]);

  useLayoutEffect(() => {
    if (!open || inline !== false) {
      setLayer(undefined);
      return;
    }
    const theme = root.current?.closest('[data-theme]')?.getAttribute('data-theme') ?? undefined;
    const update = () => {
      const p = place();
      if (p) setLayer({ theme, place: p });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, inline, root, place]);

  return {
    inline,
    layer,
    ready: inline === true || layer !== undefined,
    portal: (node: ReactNode) => (inline ? node : createPortal(node, document.body)),
  };
}
