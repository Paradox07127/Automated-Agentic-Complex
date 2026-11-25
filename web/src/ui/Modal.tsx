import { useLayoutEffect, type RefObject } from 'react';
import type { GameClip } from '../design/gameClips.generated';
import { runsEnd, startClip } from './ToggleClip';

/** Element the main-window shell provides so a dialog covers the whole window, sidebar included. */
export const MODAL_ROOT_ID = 'ef-modal-root';

/**
 * Keeps a copy of the closed overlay on screen while its exit plays: the `out` clip when given, else its `[data-closing]`
 * CSS animation. The copy is inert and hidden from assistive tech; with no exit (reduced motion, still shots) it is dropped at once.
 */
export function useExitFade(ref: RefObject<HTMLElement | null>, out?: GameClip) {
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentNode;
    return () => {
      // A StrictMode re-run keeps the node attached; only a real unmount detaches it before the microtask.
      queueMicrotask(() => {
        if (!el || !host?.isConnected || el.isConnected) return;
        const ghost = el.cloneNode(true) as HTMLElement;
        ghost.setAttribute('data-closing', '');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        for (const n of ghost.querySelectorAll('[id]')) n.removeAttribute('id');
        host.appendChild(ghost);
        if (out) {
          void runsEnd(startClip(out, ghost)).then(() => ghost.remove());
          return;
        }
        const name = getComputedStyle(ghost).animationName;
        if (!name || name === 'none') ghost.remove();
        else ghost.addEventListener('animationend', (e) => e.target === ghost && ghost.remove());
      });
    };
    // Mount-only: the node is the overlay root for its whole life.
  }, []);
}
