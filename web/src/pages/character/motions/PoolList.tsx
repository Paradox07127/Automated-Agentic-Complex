import type { MotionPoolEntry } from '../../../bridge';
import type { MotionGraph } from './graph';
import { PoolCard } from './PoolCard';
import { candidates, packEntries, type Pool } from './pools';
import styles from './MotionPools.module.css';

export interface PoolListProps {
  graph: MotionGraph;
  pools: Pool[];
  /** Stored overrides. */
  stored: Record<string, MotionPoolEntry[]>;
  /** Unsaved: pool key → its whole pool, or null to give it back to the pack. */
  draft: Record<string, MotionPoolEntry[] | null>;
  /** Pool key → why the avatar did not take it at the last save. */
  adjusted: Record<string, string>;
  labelOf: (clip: string) => string;
  groupTitle: (id: string) => string;
  lock: string | null;
  onPool: (key: string, entries: MotionPoolEntry[] | null) => void;
}

/** 组视图：每个池子一张卡；事件池和空闲档可以加、去、调权重，整池保存，其余池子只读。 */
export function PoolList(p: PoolListProps) {
  const bad = Object.entries(p.adjusted);
  return (
    <div className={styles.pools}>
      <p className={styles.lead}>只有事件池和空闲档（idle.t1、idle.t2…）能改；保存时整个池子替换角色包里的。权重是相对的，1–100000。</p>
      {bad.length > 0 && (
        <ul className={styles.bad} aria-label="上次保存没有生效的池子">
          {bad.map(([key, why]) => (
            <li key={key}>
              <b>{key}</b> {why}
            </li>
          ))}
        </ul>
      )}
      {p.pools.length === 0 && <div className={styles.none}>角色包里没有可抽的池子</div>}
      {p.pools.map((pool) => {
        const own = pool.key in p.draft ? (p.draft[pool.key] ?? null) :(p.stored[pool.key] ?? null);
        const entries = own ?? packEntries(pool);
        return (
          <PoolCard
            key={`${pool.kind}:${pool.key}`}
            pool={pool}
            groupTitle={p.groupTitle(pool.group)}
            entries={entries}
            overridden={!pool.locked && own != null}
            unsaved={!pool.locked && pool.key in p.draft}
            candidates={pool.locked ? [] : candidates(p.graph, pool.posture, entries)}
            labelOf={p.labelOf}
            adjusted={pool.locked ? null : (p.adjusted[pool.key] ?? null)}
            lock={p.lock}
            onChange={(e) => p.onPool(pool.key, e)}
          />
        );
      })}
    </div>
  );
}
