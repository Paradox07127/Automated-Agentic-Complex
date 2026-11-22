// 任务面板（mission）的游戏动画：面板进场、格子入场、选中、追踪环和完成回执，数据来自 gameClips.generated.ts。
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { gameClips, type GameClip } from '../../design/gameClips.generated';
import { GlowLayer, useGameClip } from '../../ui';
import fx from './MissionFx.module.css';

const pick = (clip: GameClip, keys: readonly string[]): GameClip => ({ ...clip, tracks: clip.tracks.filter((t) => keys.includes(t.key)) });

const TITLE_IN = pick(gameClips.missionIn, ['listTitle', 'listTitleText', 'listTitleLine']);
/** One cycle of missiontracktip_loop per selection, so nothing loops at rest. */
const TRACK_ONCE: GameClip = { ...gameClips.missionTrackLoop, loop: false };
/** missioncomplete_in on the receipt's light layers only: the receipt stays, so its band and line hold their in-state in CSS. */
const COMPLETE = pick(gameClips.missionCompleteIn, ['halo', 'bandBg', 'light2']);

/** Category colour of a mission cell: waiting on you yellow, running blue, background green. */
export type MissionTone = 'yellow' | 'blue' | 'green';

/** missioninfo_in on a detail block outside the panel (the shell's action band). */
export function useInfoIn<T extends Element>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useGameClip(gameClips.missionInfoIn, ref, { autoplay: true });
  return ref;
}

/** missionmaincell_in: the cell fades in when it mounts. */
export function useCellIn<T extends Element>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useGameClip(gameClips.missionCellIn, ref, { autoplay: true });
  return ref;
}

/** The list's group head: the title fades in, its text flickers and the rule after it grows. */
export function GroupHead({ className, icon, children }: { className?: string | undefined; icon: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useGameClip(TITLE_IN, ref, { autoplay: true });
  return (
    <div ref={ref} className={className} aria-hidden="true" data-g="listTitle">
      {icon}
      <span data-g="listTitleText">{children}</span>
      <span className={fx.grpLine} data-g="listTitleLine" />
    </div>
  );
}

/** missioncell_selecting_in under a selected cell: the band grows in from the right with its plate and twill, the glow bar rises at the left edge, the frame flickers. */
export function Selected({ tone }: { tone: MissionTone }) {
  const ref = useRef<HTMLSpanElement>(null);
  useGameClip(gameClips.missionCellSelect, ref, { autoplay: true });
  return (
    <span ref={ref} className={fx.sel} data-tone={tone} aria-hidden="true">
      <span className={fx.band} data-g="band">
        <span className={fx.plate} data-g="twill" />
        <span className={fx.twill} data-g="mask" />
      </span>
      <span className={fx.bar} data-g="bar" />
      <span className={fx.line} data-g="line" />
    </span>
  );
}

/** The tracking rings around a cell's icon (root carries `data-g="ringOuter"`); unmounts itself after one cycle. */
export function TrackTip({ root, tone, onDone }: { root: RefObject<HTMLElement | null>; tone: MissionTone; onDone: () => void }) {
  const clip = useGameClip(TRACK_ONCE, root, { autoplay: true });
  useEffect(() => {
    let alive = true;
    void clip.finished.then(() => alive && onDone());
    return () => {
      alive = false;
    };
  });
  return (
    <span className={fx.tip} data-tone={tone} aria-hidden="true">
      <span className={fx.ring} data-g="ring" />
      <span className={fx.ring} data-g="ring1" />
      <span className={fx.ring} data-g="ring2" />
    </span>
  );
}

/** The light layers of the task complete popup behind the receipt; they rise and fade out over three seconds. */
export function CompleteFx({ root }: { root: RefObject<HTMLElement | null> }) {
  useGameClip(COMPLETE, root, { autoplay: true });
  return (
    <span className={fx.complete} aria-hidden="true">
      <span className={fx.bandBg} data-g="bandBg" />
      <span className={fx.light} data-g="light2" />
      <span className={fx.halo}>
        <GlowLayer w={161.5} h={161.5} sprite="pages/overview/complete-halo" tone="lemon" opacity={0.15} g="halo" />
      </span>
    </span>
  );
}
