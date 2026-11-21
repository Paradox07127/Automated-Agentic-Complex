import { useLayoutEffect, useRef, type RefObject } from 'react';
import { gameClips, type GameClip } from '../design/gameClips.generated';
import { playOnce } from './fx/motion';

/** Plays a game clip once on the `[data-g]` nodes under root (root included); each run drops at its end, so the CSS state at rest is the end frame. */
export function playClip(clip: GameClip, root: Element | null | undefined): void {
  startClip(clip, root);
}

/** playClip that returns the runs it started: none when calm or when no node under root carries a track key. */
export function startClip(clip: GameClip, root: Element | null | undefined): Animation[] {
  const runs: Animation[] = [];
  if (!root) return runs;
  for (const t of clip.tracks) {
    const sel = `[data-g="${t.key}"]`;
    const frames = t.keyframes.map((k) => ({ offset: k.offset, easing: k.easing, [t.property]: k.value }));
    for (const el of [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)]) {
      const a = playOnce(el, frames, { duration: clip.duration });
      if (a) runs.push(a);
    }
  }
  return runs;
}

/** Resolves when every run has ended or been cancelled; at once for none. */
export function runsEnd(runs: readonly Animation[]): Promise<void> {
  return Promise.all(runs.map((a) => a.finished.catch(() => undefined))).then(() => undefined);
}

/** common_toggle_to_left (to 开) / _to_right (to 关) whenever the state flips; nothing on mount. */
export function useToggleClip(ref: RefObject<HTMLElement | null>, on: boolean): void {
  const last = useRef(on);
  useLayoutEffect(() => {
    if (last.current === on) return;
    last.current = on;
    playClip(on ? gameClips.toggleToLeft : gameClips.toggleToRight, ref.current);
  }, [on, ref]);
}
