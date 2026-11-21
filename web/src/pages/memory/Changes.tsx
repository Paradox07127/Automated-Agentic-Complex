import { useState } from 'react';
import { Icon, OpenSec, Region, type RegionSource } from '../../ui';
import { countOps, hm, OPS, stamp, type Batch, type Change } from './model';
import m from './Memory.module.css';
import styles from './Changes.module.css';

/** A change that arrived on /feed while the page was open. */
export type LiveChange = Change & { key: string; at: number };

export interface ChangesProps {
  /** The consolidation batches, read on their own. */
  source: RegionSource<Batch[]>;
  live: LiveChange[];
  recording: boolean;
  now: number;
  /** Whether a fact is still there to open. */
  has: (id: string) => boolean;
  onOpen: (id: string) => void;
  /** 撤销本批; absent while agentd cannot roll a batch back. */
  onUndo?: (b: Batch) => void;
  undone: ReadonlySet<string>;
}

const LIVE = 'live';

/** 最近变化：后台整理批次（新的在前，默认只展开最新一批），加上页面打开后 /feed 推来的实时变化。 */
export function Changes({ source, live, recording, now, has, onOpen, onUndo, undone }: ChangesProps) {
  const batches = source.data ?? [];
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const open = (id: string) => toggled[id] ?? (id === LIVE || id === batches[0]?.id);
  const flip = (id: string) => setToggled((t) => ({ ...t, [id]: !open(id) }));

  const item = (c: Change, key: string, fresh?: boolean) => (
    <div key={key} className={styles.item} data-op={c.op} data-fresh={fresh || undefined}>
      <span className={styles.op}>
        <b aria-hidden="true">{OPS[c.op].sym}</b>
        {OPS[c.op].label}
      </span>
      {c.id && c.op !== 'del' && has(c.id) ? (
        <button type="button" className={`${styles.txt} ${styles.link}`} onClick={() => onOpen(c.id ?? '')}>
          {c.text}
        </button>
      ) : (
        <span className={styles.txt} data-gone={c.op === 'del' || undefined}>
          {c.text}
        </span>
      )}
      {c.was && <span className={`${styles.was} ${m.cap}`}>原：{c.was}</span>}
      {fresh && <span className={m.just}>新</span>}
    </div>
  );

  const head = (id: string, at: string, items: Change[], label: string) => {
    const n = countOps(items);
    return (
      <button type="button" className={styles.rh} aria-expanded={open(id)} onClick={() => flip(id)}>
        <span className={styles.fold} aria-hidden="true">
          <Icon name={open(id) ? 'chevd' : 'chev'} size={14} />
        </span>
        <span className={`${styles.at} num`}>{at}</span>
        <span className={styles.lb}>{label}</span>
        <span className={styles.cnts}>
          新增 <span className="num">{n.add}</span>
          <span aria-hidden="true">│</span>更新 <span className="num">{n.upd}</span>
          <span aria-hidden="true">│</span>删除 <span className="num">{n.del}</span>
        </span>
      </button>
    );
  };
  const when = (t: number) => (stamp(t, now).startsWith('今天') ? hm(t) : stamp(t, now));

  return (
    <OpenSec
      title="最近变化"
      right={
        recording ? (
          <span className={styles.live}>
            <i aria-hidden="true" />
            实时
          </span>
        ) : (
          <span className={m.cap}>已暂停</span>
        )
      }
    >
      <div className={styles.runs} aria-live="polite">
        {!recording && <div className={styles.paused}>已暂停 │ 不新增、不更新，已有记忆照常引用</div>}
        {live.length > 0 && (
          <div className={styles.run} data-live="">
            {head(LIVE, hm(live[0]?.at ?? now), live, '实时')}
            {open(LIVE) && <div className={styles.items}>{live.map((c) => item(c, c.key, true))}</div>}
          </div>
        )}
        <Region q={source} what="整理记录" reserve={{ rows: 2 }} empty={{ text: '还没有整理记录，对话后后台会定时整理' }}>
          {(list) => (
            <div className={styles.runs}>
              {list.map((b) => (
                <div key={b.id} className={styles.run} data-undone={undone.has(b.id) || undefined}>
                  <div className={styles.rhw}>
                    {head(b.id, when(b.at), b.items, '整理批次')}
                    <span className={m.sp} />
                    {onUndo &&
                      (undone.has(b.id) ? (
                        <span className={m.cap}>已撤销</span>
                      ) : (
                        <button type="button" className={m.lnk} onClick={() => onUndo(b)}>
                          撤销本批
                        </button>
                      ))}
                  </div>
                  {open(b.id) && <div className={styles.items}>{b.items.map((c, j) => item(c, `${b.id}-${j}`))}</div>}
                </div>
              ))}
            </div>
          )}
        </Region>
      </div>
    </OpenSec>
  );
}
