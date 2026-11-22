// 编排 with agentd's motion groups: the picked pool's proposals and refusals under its member rows, and the clips no pool takes.
import { useState, type ReactNode } from 'react';
import type { MotionGroupPool, MotionGroupProposal, MotionGroups } from '../../../bridge/motionGroups';
import { Btn } from '../../../ui';
import { DarkRow } from '../../../ui/game';
import { useCompact } from '../compact';
import { shortName } from './graph';
import styles from './Groups.module.css';

/** Why a pool does not take a clip (agentd's `rejected`); other reasons show as they come. */
export const REFUSED: Record<string, string> = {
  unknown_clip: '不在角色包里',
  excluded_family: '起始或收尾在排除的姿势族',
  no_return: '回不到站姿',
  stance_mismatch: '站姿和池子不一致',
};
/** Why no pool takes a clip (agentd's `excluded`): the pack plays it, a rule of groups.json, or only a chain reaches it. */
const EXCLUDED: Record<string, string> = {
  wired: '角色包在别处播',
  in_chain: '只在别的链里',
  battle: '战斗',
  monster: '怪物和首领',
  cutscene: '过场',
  locomotion: '走跑转身',
  prop: '道具互动',
};

/** A section head with the \\──□ line deco that folds its rows. */
function GroupFold({ title, n, open: first = false, children }: { title: string; n: number; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(first);
  return (
    <div className={styles.fold} data-open={open || undefined}>
      <button type="button" className={styles.head} aria-expanded={open} onClick={() => setOpen(!open)}>
        <i className={styles.chev} aria-hidden="true" />
        <span>{title}</span>
        <span className={styles.n}>{n}</span>
        <span className={styles.orn} aria-hidden="true" />
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}

export interface PoolProposalsProps {
  group: MotionGroupPool;
  /** Its proposals that are not members and were not dropped. */
  pending: MotionGroupProposal[];
  /** Why 收下 is off (a lock, a full pool); null when it is on. */
  acceptBlock: string | null;
  onPreview: (clip: string) => void;
  onAccept: (x: MotionGroupProposal) => void;
  onDrop: (clip: string) => void;
}

/** 她建议 (open) and 没收的 (folded) of the picked pool. */
export function PoolProposals(p: PoolProposalsProps) {
  const compact = useCompact();
  return (
    <>
      {p.pending.length > 0 && (
        <GroupFold title="她建议" n={p.pending.length} open>
          {p.pending.map((x) => (
            <div key={x.clip} className={styles.row} data-proposal={x.clip}>
              <DarkRow
                title={shortName(x.clip)}
                sub={x.why}
                compact={compact}
                onPress={() => p.onPreview(x.clip)}
                end={
                  <>
                    <Btn size="sm" variant="ghost" disabled={p.acceptBlock != null} disabledReason={p.acceptBlock ?? undefined} onClick={() => p.onAccept(x)}>
                      收下
                    </Btn>
                    <Btn size="sm" variant="secondary" onClick={() => p.onDrop(x.clip)}>
                      不要
                    </Btn>
                  </>
                }
              />
            </div>
          ))}
        </GroupFold>
      )}
      {p.group.rejected.length > 0 && (
        <GroupFold title="没收的" n={p.group.rejected.length}>
          {p.group.rejected.map((r) => (
            <div key={r.clip} className={styles.row} data-refused={r.clip}>
              <DarkRow title={shortName(r.clip)} sub={REFUSED[r.reason] ?? r.reason} compact={compact} onPress={() => p.onPreview(r.clip)} />
            </div>
          ))}
        </GroupFold>
      )}
    </>
  );
}

/** 没进任何池 (folded): the excluded clips by reason, then the unclassified ones. */
export function Outside({ groups, onPreview }: { groups: MotionGroups; onPreview: (clip: string) => void }) {
  const n = groups.excluded.length + groups.unclassified.length;
  if (n === 0) return null;
  const reasons = [...new Set(groups.excluded.map((x) => x.reason))];
  const band = (key: string, label: string, clips: string[]) => (
    <div key={key} className={styles.band} data-reason={key}>
      <span className={styles.bh}>
        {label}
        <span className={styles.n}>{clips.length}</span>
      </span>
      <div className={styles.grid}>
        {clips.map((c) => (
          <div key={c} className={styles.row} data-outside={c}>
            <DarkRow title={shortName(c)} compact onPress={() => onPreview(c)} />
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className={styles.outside}>
      <GroupFold title="没进任何池" n={n}>
        {reasons.map((r) =>
          band(
            r,
            EXCLUDED[r] ?? r,
            groups.excluded.filter((x) => x.reason === r).map((x) => x.clip),
          ),
        )}
        {groups.unclassified.length > 0 && band('unclassified', '未分类', groups.unclassified)}
      </GroupFold>
    </div>
  );
}

/** The counts readout of the pane's head. */
export function Counts({ counts: c }: { counts: MotionGroups['counts'] }) {
  const items: Array<[string, number]> = [
    ['片段', c.clips],
    ['已入池', c.pooled],
    ['建议', c.proposals],
    ['没收', c.rejected],
    ['排除', c.excluded],
    ['未分类', c.unclassified],
  ];
  return (
    <span className={styles.counts} data-counts="">
      {items.map(([label, n]) => (
        <span key={label}>
          {label} <b>{n}</b>
        </span>
      ))}
    </span>
  );
}
