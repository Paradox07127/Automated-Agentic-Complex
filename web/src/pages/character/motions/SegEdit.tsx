import { useState } from 'react';
import { Btn, Select } from '../../../ui';
import type { Candidate } from './chainEdit';
import { shortName } from './graph';
import styles from './MotionDetail.module.css';

export interface SegEditProps {
  clip: string;
  /** Clips that fit this segment, nearest first; null on the first segment, which cannot be swapped or preceded. */
  options: Candidate[] | null;
  loop: boolean;
  /** The hold shown on a loop, in seconds. */
  hold: number | null | undefined;
  /** In Chinese, from the last check or apply. */
  problems: string[];
  lock: string | null;
  onReplace: (clip: string) => void;
  onInsert: (clip: string) => void;
  onHold: (seconds: number) => void;
}

const cm = (gap: number | null) => (gap == null ? '未测' : `${gap} cm`);
const optionText = (c: Candidate) => `${shortName(c.clip)} │ 前 ${cm(c.before)}${c.after === undefined ? '' : ` │ 后 ${cm(c.after)}`}`;

/** 「编辑结构」 on one segment: a clip that fits to swap it for or insert before it (no drag and drop), its hold, its problems. */
export function SegEdit(p: SegEditProps) {
  const [pick, setPick] = useState('');
  const name = shortName(p.clip);
  const chosen = p.options?.some((o) => o.clip === pick) ? pick : (p.options?.[0]?.clip ?? '');
  const off = p.lock != null || chosen === '';
  return (
    <div className={styles.segEdit} data-seg-edit="">
      {p.options && p.options.length === 0 && <span className={styles.sub}>没有同站姿、同姿势族的片段可换</span>}
      {p.options && p.options.length > 0 && (
        <>
          <Select
            label={`换「${name}」或插在它前面的片段`}
            value={chosen}
            options={p.options.map((o) => ({ value: o.clip, label: optionText(o) }))}
            disabled={p.lock != null}
            onChange={setPick}
          />
          <span className={styles.segActs}>
            <Btn size="sm" variant="secondary" disabled={off} onClick={() => p.onReplace(chosen)}>
              换成
            </Btn>
            <Btn size="sm" variant="secondary" disabled={off} onClick={() => p.onInsert(chosen)}>
              在此前插入
            </Btn>
          </span>
        </>
      )}
      {p.loop && (
        <label className={styles.holdEdit}>
          <span className={styles.sub}>保持</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={p.hold ?? ''}
            aria-label={`「${name}」保持秒数`}
            disabled={p.lock != null}
            onChange={(e) => {
              const s = Number(e.currentTarget.value);
              if (e.currentTarget.value !== '' && Number.isFinite(s) && s >= 0) p.onHold(s);
            }}
          />
          <span className={styles.sub}>s</span>
        </label>
      )}
      {p.problems.map((t) => (
        <span key={t} className={styles.why} data-problem="">
          {t}
        </span>
      ))}
    </div>
  );
}
