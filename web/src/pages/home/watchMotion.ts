import { useEffect, useState, type RefObject } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { useGameClip } from '../../ui';

/** Whether the window is shown and has focus: watch_loop and the red dot's breath run only then. */
export function useAttended(): boolean {
  const read = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  return on;
}

/** watch_loop on the rings under root: it runs while `on` and holds where it stands otherwise, so losing focus does
 *  not snap the rings back. */
export function Sway({ root, on }: { root: RefObject<HTMLElement | null>; on: boolean }) {
  const clip = useGameClip(gameClips.watchLoop, root);
  useEffect(() => {
    if (on) void clip.play();
    else clip.pause();
  }, [clip, on]);
  return null;
}
