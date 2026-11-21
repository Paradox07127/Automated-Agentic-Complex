import { useState } from 'react';
import type { MotionPoolEntry } from '../../../bridge';
import { Btn, Select } from '../../../ui';
import { shortName } from './graph';
import { asWeight, type Pool } from './pools';
import styles from './MotionPools.module.css';

export const MAX_ENTRIES = 64;

export interface PoolCardProps {
  pool: Pool;
  groupTitle: string;
  /** The pool shown: the draft or stored override, else the pack's. */
  entries: MotionPoolEntry[];
  /** The override is in the draft or the store. */
  overridden: boolean;
  unsaved: boolean;
  /** Chain starts that can be added. */
  candidates: string[];
  labelOf: (clip: string) => string;
  /** Why the avatar did not take this pool at the last save. */
  adjusted: string | null;
  lock: string | null;
  onChange: (entries: MotionPoolEntry[] | null) => void;
}

function Weight({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (w: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const n = Number(text);
    setText(null);
    if (text.trim() !== '' && Number.isFinite(n)) onCommit(asWeight(n));
  };
  return (
    <input
      className={styles.weight}
      type="number"
      inputMode="numeric"
      min={1}
      max={100000}
      step={1}
      aria-label={`「${label}」的权重`}
      value={text ?? String(value)}
      disabled={disabled}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

const POSTURE: Record<string, string> = { sit: '坐着', floor: '坐地上', lie: '躺着' };

/** 一个池子：键、分组、姿态 │ 每个片段的权重和去掉 │ 加片段、用包里的；不能改的池子只列出来并写原因。 */
export function PoolCard(p: PoolCardProps) {
  const { pool } = p;
  const total = p.entries.reduce((s, e) => s + e.weight, 0);
  const set = (i: number, w: number) => p.onChange(p.entries.map((e, j) => (j === i ? { ...e, weight: w } : e)));
  const off = p.lock != null;
  return (
    <section className={styles.pool} aria-label={`池子 ${pool.key}`} data-pool={pool.key} data-locked={pool.locked != null || undefined}>
      <div className={styles.ph}>
        <b className={styles.key}>{pool.key}</b>
        <span>{p.groupTitle}</span>
        {POSTURE[pool.posture] && <span>{POSTURE[pool.posture]}</span>}
        {p.overridden && <span className={styles.tag}>已改</span>}
        {p.unsaved && <i className={styles.chg} title="未保存" aria-label="未保存" />}
      </div>
      {pool.locked ? (
        <>
          <ul className={styles.entries}>
            {pool.entries.map((e) => (
              <li key={e.clip} className={styles.entry} data-clip={e.clip}>
                <span className={styles.nm} title={e.clip}>
                  {p.labelOf(e.clip)}
                </span>
                <span className={styles.num}>{e.weight ?? '—'}</span>
              </li>
            ))}
          </ul>
          <span className={styles.why}>{pool.locked}</span>
        </>
      ) : (
        <>
          <ul className={styles.entries}>
            {p.entries.map((e, i) => (
              <li key={e.clip} className={styles.entry} data-clip={e.clip}>
                <span className={styles.nm} title={e.clip}>
                  {p.labelOf(e.clip)}
                  <small>{shortName(e.clip)}</small>
                </span>
                <span className={styles.share}>{total > 0 ? `${Math.round((e.weight / total) * 100)}%` : ''}</span>
                <Weight label={p.labelOf(e.clip)} value={e.weight} disabled={off} onCommit={(w) => set(i, w)} />
                <Btn
                  size="sm"
                  variant="quiet"
                  disabled={off || p.entries.length <= 1}
                  {...(p.entries.length <= 1 ? { disabledReason: '池子里至少要有一个片段' } : off ? { disabledReason: p.lock! } : {})}
                  onClick={() => p.onChange(p.entries.filter((_, j) => j !== i))}
                >
                  去掉
                </Btn>
              </li>
            ))}
          </ul>
          <div className={styles.add}>
            <Select
              value=""
              label={`往 ${pool.key} 加片段`}
              disabled={off || p.candidates.length === 0 || p.entries.length >= MAX_ENTRIES}
              options={[{ value: '', label: p.candidates.length > 0 ? '加一个同姿态的链起头…' : '没有可加的链起头' }, ...p.candidates.map((k) => ({ value: k, label: p.labelOf(k) }))]}
              onChange={(v) => v && p.onChange([...p.entries, { clip: v, weight: 1 }])}
            />
            {p.overridden && !off && (
              <Btn size="sm" variant="quiet" onClick={() => p.onChange(null)}>
                用包里的
              </Btn>
            )}
          </div>
          {p.adjusted && <span className={styles.why} data-adjusted="">{p.adjusted}</span>}
        </>
      )}
    </section>
  );
}
