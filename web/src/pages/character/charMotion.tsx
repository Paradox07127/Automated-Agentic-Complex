// Game clips of the charinfo panel on the operator view; the stage's live preview is not driven here.
import { useEffect, useRef, type RefObject } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { useGameClip } from '../../ui';
import styles from './charMotion.module.css';

/** `?still=1` from the URL: the shell marks html.still only after the page's first effects ran. */
export const still = () => /[?&]still=1(&|$)/.test(window.location.hash);

/** charinfo_in on the operator view, charinfobasic_in on the stage column and charlistnode_in on the roster, once on mount. */
export function useCharEntrance(op: RefObject<HTMLElement | null>, mid: RefObject<HTMLElement | null>, roster: RefObject<HTMLElement | null>) {
  useGameClip(gameClips.charInfoIn, op, { autoplay: !still() });
  useGameClip(gameClips.charBasicIn, mid, { autoplay: !still() });
  useGameClip(gameClips.charListIn, roster, { autoplay: !still() });
}

/** charinfobasic_switching on the name plate (`root` under the stage column) when the current character changes. */
export function useSwitchFade(mid: RefObject<HTMLElement | null>, current: string) {
  const clip = useGameClip(gameClips.charBasicSwitch, mid);
  const last = useRef(current);
  useEffect(() => {
    if (last.current === current) return;
    last.current = current;
    void clip.play();
  }, [current, clip]);
}

/** smallcharhead_in in the current roster card: the yellow bar spreads and the selection glow rises behind the head. */
export function HeadPick() {
  const ref = useRef<HTMLSpanElement>(null);
  useGameClip(gameClips.charHeadSelect, ref, { autoplay: !still() });
  return (
    <span ref={ref} className={styles.pick} aria-hidden="true">
      <i className={styles.pickSel} data-g="sel" />
      <i className={styles.pickBar} data-g="bg" />
    </span>
  );
}
