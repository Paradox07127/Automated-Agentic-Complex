import type { CSSProperties } from 'react';
import type { Fact, MemorySource } from '../../domain';
import { SrcGlyph } from './bits';
import { md, SRC, SRC_ORDER, sum } from './model';
import m from './Memory.module.css';
import styles from './Overview.module.css';

export interface OverviewProps {
  /** Active facts (candidates are listed under 待确认). */
  facts: readonly Fact[];
  /** Facts recorded per day, oldest first, today last. */
  added: number[];
  /** First day of the 14. */
  since: number;
  value: MemorySource | null;
  onPick: (src: MemorySource | null) => void;
}

/** 14 天新增火花线：随容器宽度伸缩，只标今天（强调色）和峰值。 */
function Trend({ pts, since }: { pts: number[]; since: number }) {
  const n = pts.length;
  const mx = Math.max(1, ...pts);
  const W = 100;
  const H = 28;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => 2 + (1 - v / mx) * (H - 4);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join('');
  const before = pts.slice(0, n - 1);
  const pk = before.indexOf(Math.max(...before));
  const today = pts[n - 1] ?? 0;
  return (
    <div className={styles.trend} role="img" aria-label={`14 天新增：共 ${sum(pts)} 条，今天 ${today} 条，单日最多 ${mx} 条`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className={styles.base} vectorEffect="non-scaling-stroke" />
        <path d={`${d}L${W} ${H}L0 ${H}Z`} className={styles.area} />
        <path d={d} className={styles.line} vectorEffect="non-scaling-stroke" />
      </svg>
      {(pts[pk] ?? 0) > 0 && (
        <span className={`${styles.peak} num`} style={{ left: `${x(pk)}%`, top: `${y(pts[pk] ?? 0)}px` }} aria-hidden="true">
          {pts[pk]}
        </span>
      )}
      <span className={styles.now} style={{ top: `${y(today)}px` }} />
      <span className={`${styles.axis} num`} aria-hidden="true">
        <span>{md(since)}</span>
        <span>今天</span>
      </span>
    </div>
  );
}

/** 记忆概况窄带：按来源的比例条（分类色，点一段筛选列表）+ 14 天新增火花线。 */
export function Overview({ facts, added, since, value, onPick }: OverviewProps) {
  const parts = SRC_ORDER.map((s) => ({ src: s, v: facts.filter((f) => f.source === s).length }));
  const total = sum(parts.map((p) => p.v));
  const pick = (s: MemorySource) => onPick(value === s ? null : s);
  const state = (s: MemorySource) => (value === s ? 'on' : value ? 'dim' : undefined);
  return (
    <section className={styles.band} aria-label="记忆概况">
      <div className={styles.total}>
        <span className={styles.lab}>记忆概况</span>
        <span className={`${styles.big} num`}>{total}</span>
        <span className={styles.unit}>条</span>
      </div>
      <div className={styles.col}>
        <div className={styles.hd}>
          <span>按来源</span>
          <span className={m.sp} />
          {value && (
            <button type="button" className={m.lnk} onClick={() => onPick(null)}>
              清除筛选
            </button>
          )}
        </div>
        {total === 0 ? (
          <div className={styles.ratio} data-none="" role="img" aria-label="还没有记忆" />
        ) : (
          <div className={styles.ratio} role="group" aria-label={`按来源：${parts.map((p) => `${SRC[p.src].short} ${p.v}`).join('，')}`}>
            {parts
              .filter((p) => p.v > 0)
              .map((p) => (
                <button
                  key={p.src}
                  type="button"
                  data-src={SRC[p.src].key}
                  data-state={state(p.src)}
                  style={{ flexGrow: p.v } as CSSProperties}
                  aria-pressed={value === p.src}
                  aria-label={`${SRC[p.src].full} ${p.v} 条`}
                  onClick={() => pick(p.src)}
                />
              ))}
          </div>
        )}
        <div className={styles.legend}>
          {parts.map((p) => (
            <button key={p.src} type="button" className={styles.lg} data-state={state(p.src)} disabled={!p.v} aria-pressed={value === p.src} onClick={() => pick(p.src)}>
              <SrcGlyph src={p.src} />
              <span>{SRC[p.src].short}</span>
              <span className={`${styles.lgN} num`}>{p.v}</span>
              <span className={`${m.cap} num`}>{total ? Math.round((p.v / total) * 100) : 0}%</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.col}>
        <div className={styles.hd}>
          <span>14 天新增</span>
          <span className={`${m.t1} num`}>{sum(added)}</span>
          <span className={m.sp} />
          <span className={m.cap}>
            今天 <span className={`${styles.today} num`}>+{added[added.length - 1] ?? 0}</span>
          </span>
        </div>
        {sum(added) > 0 ? (
          <Trend pts={added} since={since} />
        ) : (
          <div className={styles.trend} data-none="">
            <span>14 天里没有新增</span>
          </div>
        )}
      </div>
    </section>
  );
}
