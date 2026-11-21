// Game clips of the charinfo panel on the operator view; the stage's live preview is not driven here.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { useGameClip } from '../../ui';
import { useAttended } from '../home/watchMotion';
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

/** attributecell_selected_in on the selected motion's index, then its loop while the window has focus. */
export function SelMark() {
  const ref = useRef<HTMLElement>(null);
  const attended = useAttended();
  const markIn = useGameClip(gameClips.charMarkIn, ref, { autoplay: !still() });
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let live = true;
    void markIn.finished.then(() => live && setSettled(true));
    return () => {
      live = false;
    };
  }, [markIn]);
  return (
    <i ref={ref} className={styles.mark} data-g="root" aria-hidden="true">
      {settled && attended && !still() && <MarkLoop root={ref} />}
    </i>
  );
}

function MarkLoop({ root }: { root: RefObject<HTMLElement | null> }) {
  useGameClip(gameClips.charMarkLoop, root, { autoplay: true });
  return null;
}
