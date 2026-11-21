// Game clips of the guide media panel (guidemedia_in / _out) on the onboarding guide.
import { useRef, type ReactNode, type RefObject } from 'react';
import { gameClips, type GameClip } from '../../design/gameClips.generated';
import { useGameClip } from '../../ui';
import { still } from '../character/charMotion';
import styles from './Page.module.css';

const IN = gameClips.guideMediaIn;
/** Tracks on the layers that stay across page turns: the blur, the bottom ramp, the hint and the primary button. */
const STAY = ['blur', 'ramp', 'hint', 'close'];
const part = (keys: (k: string) => boolean, duration = IN.duration): GameClip => ({ ...IN, duration, tracks: IN.tracks.filter((t) => keys(t.key)) });
const BACK_IN = part((k) => k !== 'close' && STAY.includes(k));
const CLOSE_IN = part((k) => k === 'close');
const MEDIA_IN = part((k) => !STAY.includes(k));
/** The game has no page-turn clip; a turn replays the media entrance in 417 ms. */
const TURN_IN = part((k) => !STAY.includes(k), 417);

/** guidemedia_in on the backing layers once, and the exit clip to play before the guide closes. */
export function useGuideMotion(root: RefObject<HTMLElement | null>) {
  useGameClip(BACK_IN, root, { autoplay: !still() });
  return useGameClip(gameClips.guideMediaOut, root);
}

/** guidemedia_in on one page of the media panel; mounted inside the page so each turn plays again. */
export function MediaIn({ root, turned }: { root: RefObject<HTMLElement | null>; turned: boolean }) {
  useGameClip(turned ? TURN_IN : MEDIA_IN, root, { autoplay: !still() });
  return null;
}

/** The step's primary button; it fades in with the panel's close button track. */
export function Primary({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useGameClip(CLOSE_IN, ref, { autoplay: !still() });
  return (
    <span ref={ref} className={styles.primary} data-g="close">
      {children}
    </span>
  );
}
