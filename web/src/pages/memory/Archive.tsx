import { useRef, type ReactNode } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { Breath, CountBadge } from '../../ui';
import { hm } from './model';
import { useEntrance, useExit, useHoverClip, type LeaveSlot } from './motion';
import type { WorkTask } from './Projects';
import styles from './Archive.module.css';

/** The views a small archive card opens. */
export type ArchiveView = 'activity' | 'about' | 'knowledge';

export interface ArchiveProps {
  /** The work-memory tasks; undefined while still reading. */
  tasks: WorkTask[] | undefined;
  /** Active facts and open asks of 用户档案 and of 其他事实与线索. */
  about: { count: number; asks: number };
  knowledge: { count: number; asks: number };
  /** Finish time of the last consolidation run; null when there is none, undefined while still reading. */
  lastRun: number | null | undefined;
  onOpen: (v: ArchiveView) => void;
  /** Takes the panel's out clip while it is shown. */
  leave?: LeaveSlot;
}

/** The game's prtsIn keys of the three small cards. */
const CARD_G = { text: 'card1', media: 'card2', doc: 'card3' } as const;

/** Hover frame and light of a card: the frame sits outside the card's clip, in the same grid area. */
function Hover({ area, big, children }: { area: string; big?: boolean; children: (on: () => void, off: () => void) => ReactNode }) {
  const { ref, on, off } = useHoverClip<HTMLDivElement>(big ? gameClips.prtsBigCardHover : gameClips.prtsCardHover);
  return (
    <div ref={ref} className={styles.hoverCell}>
      {children(on, off)}
      <span className={styles.frame} data-area={area} data-g="frame" aria-hidden="true" />
    </div>
  );
}

/** Small card: title bottom-left, label and count bottom-right, NEW tag at the top-right corner. */
function Entry({ area, title, label, value, fresh, onOpen }: { area: keyof typeof CARD_G; title: string; label: string; value: string; fresh: number; onOpen: () => void }) {
  return (
    <Hover area={area}>
      {(on, off) => (
        <button
          type="button"
          className={`${styles.card} ${styles.small} ${styles.entranceCard}`}
          data-area={area}
          data-g={CARD_G[area]}
          onClick={onOpen}
          onPointerEnter={on}
          onPointerLeave={off}
          onFocus={on}
          onBlur={off}
        >
          <span className={styles.bar} aria-hidden="true" />
          <span className={styles.device} data-g="art" aria-hidden="true" />
          <span className={styles.dots} data-g="icon" aria-hidden="true" />
          <span className={styles.light} data-g="light" aria-hidden="true" />
          <span className={styles.name}>{title}</span>
          <span className={styles.tally}>
            <span className={styles.lab}>{label}</span>
            <span className={`${styles.n} num`}>{value}</span>
          </span>
          {fresh > 0 && (
            <span className={styles.newTag}>
              <Breath size={8} />
              <CountBadge kind="new" count={fresh} label="有待确认" />
            </span>
          )}
        </button>
      )}
    </Hover>
  );
}

/** 项目页顶部的情报档案（PRTS 主面板）：左边大卡是项目（进行中 / 已归档计数），右边三张小卡打开 其他事实与线索、活动回顾、用户档案，上下两条框线。 */
export function Archive({ tasks, about, knowledge, lastRun, onOpen, leave }: ArchiveProps) {
  const root = useRef<HTMLElement>(null);
  const entrance = useEntrance(root, gameClips.prtsIn, gameClips.prtsInSettle);
  useExit(root, gameClips.prtsOut, leave);
  const active = tasks?.filter((t) => t.status === 'active').length ?? 0;
  const done = tasks?.filter((t) => t.status === 'done').length ?? 0;
  const ongoing = active > 0 || done === 0;
  return (
    <section ref={root} className={styles.prts} aria-label="情报档案">
      {entrance}
      <div className={`${styles.rule} ${styles.frameRule}`} data-edge="top" data-g="ruleTop" aria-hidden="true">
        <span className={styles.ruleLabel}>
          <span className={styles.ruleDeco} data-g="ruleTopDeco" />
          {'// 记忆档案'}
        </span>
        <span className={`${styles.micro} ${styles.microText}`} />
      </div>
      <div className={styles.grid}>
        <Hover area="big" big>
          {(on, off) => (
            <div
              className={`${styles.card} ${styles.big}`}
              role="group"
              aria-label={`项目，${ongoing ? '进行中' : '已归档'} ${tasks ? (ongoing ? active : done) : '—'}`}
              data-g="bigCard"
              onPointerEnter={on}
              onPointerLeave={off}
            >
              <span className={styles.artBox} data-g="bigCardArt" aria-hidden="true">
                <span className={styles.scan} data-g="art" />
              </span>
              <span className={styles.light} data-g="light" aria-hidden="true" />
              <span className={styles.bar} aria-hidden="true" />
              <span className={`${styles.tag} ${styles.tagArrow}`} aria-hidden="true">
                <span>00.101</span>
              </span>
              <span className={styles.title}>项目</span>
              <span className={styles.status}>
                <span className={styles.statusLab}>{ongoing ? '进行中' : '已归档'}</span>
                <span className={`${styles.bigN} num`} data-state={ongoing ? 'ongoing' : 'archived'}>
                  {tasks ? (ongoing ? active : done) : '—'}
                </span>
              </span>
            </div>
          )}
        </Hover>
        <div className={styles.slot} data-g="slot" aria-hidden="true">
          <span className={`${styles.tag} ${styles.tagArrow}`} data-dir="out">
            <span>00.102</span>
          </span>
        </div>
        <Entry area="text" title="其他事实与线索" label="已记住" value={String(knowledge.count)} fresh={knowledge.asks} onOpen={() => onOpen('knowledge')} />
        <Entry area="media" title="活动回顾" label="上次整理" value={lastRun ? hm(lastRun) : '—'} fresh={0} onOpen={() => onOpen('activity')} />
        <Entry area="doc" title="用户档案" label="已记住" value={String(about.count)} fresh={about.asks} onOpen={() => onOpen('about')} />
      </div>
      <div className={`${styles.rule} ${styles.frameRule}`} data-edge="bottom" data-g="ruleBottom" aria-hidden="true" />
    </section>
  );
}
