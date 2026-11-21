import { useEffect, type RefObject } from 'react';
import { getBridge, type GlassRect, type Region } from '../../../bridge';

const SELECTOR = '[data-region], [data-drag]';
const GLASS = '[data-glass]';
/** A transform moves a card without a resize or a mutation: report again once it settles. */
const SETTLED = ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'];

function collect(root: HTMLElement): Region[] {
  return [...root.querySelectorAll<HTMLElement>(SELECTOR)].map((el) => {
    const r = el.getBoundingClientRect();
    const region: Region = { x: r.left, y: r.top, width: r.width, height: r.height };
    if (el.hasAttribute('data-drag')) region.drag = true;
    return region;
  });
}

function glassRects(root: HTMLElement): GlassRect[] {
  return [...root.querySelectorAll<HTMLElement>(GLASS)].flatMap((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [{ x: r.left, y: r.top, w: r.width, h: r.height }] : [];
  });
}

/**
 * Reports the `[data-region]` (clickable) and `[data-drag]` (moves the panel) rects under `ref` as the panel's interactive
 * regions, coalesced per task (not per animation frame: a hidden panel gets none, and it stays hidden until it reports a
 * region) and only when they changed. Clicks outside them pass through to the desktop. The `[data-glass]` cards go with
 * them as `glass` rects, which native backs with glass.
 */
export function useRegions(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const bridge = getBridge();
    let sent = '';
    let queued = false;
    let live = true;
    const report = () => {
      queued = false;
      if (!live) return;
      const regions = collect(root);
      const glass = glassRects(root);
      const key = JSON.stringify([regions, glass]);
      if (key === sent) return;
      sent = key;
      bridge.window.setInteractiveRegions(regions, glass);
    };
    const later = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(report);
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    const watch = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(root);
      root.querySelectorAll(`${SELECTOR}, ${GLASS}`).forEach((el) => ro.observe(el));
    };
    const mo = new MutationObserver(() => {
      watch();
      later();
    });
    mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-region', 'data-drag', 'data-glass', 'class', 'style'] });
    window.addEventListener('resize', later);
    SETTLED.forEach((type) => root.addEventListener(type, later));
    watch();
    report();
    return () => {
      live = false;
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', later);
      SETTLED.forEach((type) => root.removeEventListener(type, later));
    };
  }, [ref]);
}
