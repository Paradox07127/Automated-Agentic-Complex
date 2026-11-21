import { useEffect, useRef, useState, type RefObject } from 'react';
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

/** watch_loop on the rings under root while mounted; unmounting drops it, so the face rests at the entrance's end. */
export function Sway({ root }: { root: RefObject<HTMLElement | null> }) {
  useGameClip(gameClips.watchLoop, root, { autoplay: true });
  return null;
}

/** keyboard_btn's Highlighted clip on a key: forward on pointer or focus in, back on out. Pressed is Normal in the
 *  game: a press drops the key to rest at once, and it rises again on release. */
export function useKeyHover<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const clip = useGameClip(gameClips.keyboardBtnHover, ref);
  const on = () => void clip.play();
  const off = () => void clip.reverse();
  return { ref, onPointerEnter: on, onPointerLeave: off, onFocus: on, onBlur: off, onPointerDown: () => clip.rest(), onPointerUp: on };
}
