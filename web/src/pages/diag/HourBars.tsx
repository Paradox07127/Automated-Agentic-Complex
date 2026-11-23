import { formatMs, type Turn } from '../../domain';
import { SecHead } from '../../ui';
import { GameFrame, GameSeg } from '../../ui/game';
import styles from './Flow.module.css';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const pad2 = (n: number) => String(n).padStart(2, '0');

export interface HourBucket {
  at: number;
  n: number;
  fail: number;
  /** Median duration of the bucket's turns; null when it had none. */
  p50: number | null;
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
};

/** 24 hourly or 7 daily buckets ending at `end`. */
export function bucketsOf(turns: readonly Turn[], range: '24h' | '7d', end: number): HourBucket[] {
  const step = range === '7d' ? DAY : HOUR;
  const last = range === '7d' ? new Date(end).setHours(0, 0, 0, 0) : Math.floor(end / HOUR) * HOUR;
  const len = range === '7d' ? 7 : 24;
  return Array.from({ length: len }, (_, i) => {
    const at = last - (len - 1 - i) * step;
    const own = turns.filter((t) => t.started_at >= at && t.started_at < at + step);
    return { at, n: own.length, fail: own.filter((t) => t.result === 'failed').length, p50: median(own.map((t) => t.duration_ms).filter((d) => d > 0)) };
  });
}

export interface HourBarsProps {
  buckets: HourBucket[];
  range: '24h' | '7d';
  onRange: (r: '24h' | '7d') => void;
  /** A bar was clicked: 运行记录 from that bucket's start. */
  onPick: (at: number) => void;
  /** The read hit its row limit, so older buckets are short. */
  truncated: boolean;
}

/** 近 24 小时 / 近 7 天: one bar a bucket, grey for done and red for failed; the yellow line is the bucket's p50. */
export function HourBars({ buckets, range, onRange, onPick, truncated }: HourBarsProps) {
  const mx = Math.max(1, ...buckets.map((b) => b.n));
  const pmax = Math.max(1, ...buckets.map((b) => b.p50 ?? 0));
  const w = 100 / buckets.length;
  const name = (b: HourBucket) => (range === '7d' ? `${new Date(b.at).getMonth() + 1}/${new Date(b.at).getDate()}` : `${pad2(new Date(b.at).getHours())} 时`);
  let pen = false;
  const line = buckets
    .map((b, i) => {
      if (b.p50 == null) return ((pen = false), '');
      const seg = `${pen ? 'L' : 'M'}${((i + 0.5) * w * 10).toFixed(1)} ${(100 - (b.p50 / pmax) * 100).toFixed(1)}`;
      pen = true;
      return seg;
    })
    .join('');
  const ticks = range === '7d' ? [0, 2, 4, 6] : [0, 6, 12, 18, 23];
  return (
    <section className={styles.col} aria-label={range === '7d' ? '近 7 天' : '近 24 小时'}>
      <SecHead
        title={range === '7d' ? '近 7 天' : '近 24 小时'}
        info={`每${range === '7d' ? '天' : '小时'}一根柱：灰是成功、红是失败；黄线是那段时间的 p50 用时。点柱子去运行记录的那段时间。${truncated ? '读数到了上限，更早的轮次没有算进来。' : ''}`}
        right={
          <GameSeg
            label="范围"
            size="compact"
            value={range}
            options={[
              { value: '24h', label: '24 h' },
              { value: '7d', label: '7 天' },
            ]}
            onChange={(v) => onRange(v === '7d' ? '7d' : '24h')}
          />
        }
      />
      <GameFrame variant="chart" title={range === '7d' ? '轮次 │ 天' : '轮次 │ 小时'} micro={range === '7d' ? 'TURNS DAILY' : 'TURNS HOURLY'} label="轮次柱">
        <div className={styles.hours}>
          {buckets.map((b, i) => (
            <button
              key={b.at}
              type="button"
              className={styles.hb}
              style={{ left: `calc(${i * w}% + 1px)`, width: `calc(${w}% - 3px)` }}
              title={`${name(b)} │ ${b.n} 轮 │ 失败 ${b.fail}${b.p50 != null ? ` │ p50 ${formatMs(b.p50)}` : ''}`}
              aria-label={`${name(b)}，${b.n} 轮，失败 ${b.fail}，在运行记录里打开`}
              onClick={() => onPick(b.at)}
            >
              <i style={{ height: `${((b.n - b.fail) / mx) * 100}%` }} />
              {b.fail > 0 && <i data-f="" style={{ height: `${(b.fail / mx) * 100}%` }} />}
            </button>
          ))}
          <svg className={styles.p50} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
            <path d={line} vectorEffect="non-scaling-stroke" />
          </svg>
          <span className={styles.yl} style={{ top: 0 }} aria-hidden="true">
            {mx}
          </span>
          <span className={styles.yl} style={{ top: '100%' }} aria-hidden="true">
            0
          </span>
        </div>
        <div className={styles.ax} aria-hidden="true">
          {ticks.map((i) => {
            const b = buckets[i];
            return b ? (
              <span key={i} style={{ left: `${(i + 0.5) * w}%` }}>
                {name(b)}
              </span>
            ) : null;
          })}
        </div>
      </GameFrame>
    </section>
  );
}
