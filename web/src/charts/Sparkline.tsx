import { useId } from 'react';
import { lastIndex, linePath } from './scale';
import palette from './palette.module.css';
import styles from './Sparkline.module.css';

/** 迷你趋势线：60×16 或 120×24，s1 线宽 1.5–2，最新点 4 px；不画轴，只标最大或最新值。 */
export interface SparklineProps {
  /** 数据点，null 为缺口 */
  points: Array<number | null>;
  /** 读屏名称 */
  label: string;
  /** 60×16 / 120×24，默认 sm */
  size?: 'sm' | 'md';
  /** 标注最新或最大值，默认 last */
  mark?: 'last' | 'max';
  /** 旁注读数，例如「今天 1.24 M · 峰 1.31 M」 */
  readout?: string;
  /** 参考线（例如心情基线） */
  baseline?: number;
  /** 阶梯折线：状态值保持到下一个点（心情、精力） */
  step?: boolean;
  /** 线用强调色（这条是读者该看的那个值） */
  emph?: boolean;
}

const BOX = { sm: { w: 60, h: 16 }, md: { w: 120, h: 24 } } as const;

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)).replace('-', '−');

/** Geometry of the line: y range includes the baseline; values below it are drawn in s2. */
export function sparkGeometry(points: ReadonlyArray<number | null>, w: number, h: number, baseline?: number, step = false) {
  const vs = points.filter((v): v is number => v != null);
  const lo = Math.min(...vs, baseline ?? Infinity);
  const hi = Math.max(...vs, baseline ?? -Infinity);
  const x = (i: number) => 2 + (i / Math.max(1, points.length - 1)) * (w - 4);
  const y = (v: number) => (hi === lo ? h / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (h - 4));
  return { lo, hi, x, y, path: linePath(points, x, y, step) };
}

export function Sparkline({ points, label, size = 'sm', mark = 'last', readout, baseline, step, emph }: SparklineProps) {
  const clip = useId();
  const { w, h } = BOX[size];
  const li = lastIndex(points);
  if (li < 0) {
    return (
      <span role="img" data-stub="Sparkline" data-size={size} className={styles.root} aria-label={`${label}：没有数据`}>
        <span className={styles.none}>—</span>
        {readout && <span className={styles.value}>{readout}</span>}
      </span>
    );
  }
  const { x, y, path } = sparkGeometry(points, w, h, baseline, step);
  const vs = points.filter((v): v is number => v != null);
  const last = points[li] as number;
  const peak = Math.max(...vs);
  const pi = points.indexOf(peak);
  const markI = mark === 'max' ? pi : li;
  const markV = mark === 'max' ? peak : last;
  const below = baseline != null && vs.some((v) => v < baseline);
  const by = baseline != null ? y(baseline) : 0;
  const text = readout ?? (mark === 'max' ? `峰 ${fmt(peak)}` : fmt(last));
  return (
    <span role="img" data-stub="Sparkline" data-size={size} data-mark={mark} data-baseline={baseline} data-step={step || undefined} data-below={below || undefined} data-emph={emph || undefined} className={`${palette.palette} ${styles.root}`} aria-label={`${label}：最新 ${fmt(last)}，最大 ${fmt(peak)}${baseline != null ? `，基线 ${fmt(baseline)}` : ''}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className={styles.svg}>
        {baseline != null && <line className={styles.base} x1={0} x2={w} y1={by} y2={by} />}
        {below ? (
          <>
            <clipPath id={`${clip}a`}>
              <rect x={0} y={-2} width={w} height={by + 2} />
            </clipPath>
            <clipPath id={`${clip}b`}>
              <rect x={0} y={by} width={w} height={h - by + 2} />
            </clipPath>
            <path d={path} className={styles.line} clipPath={`url(#${clip}a)`} />
            <path d={path} className={styles.lineBelow} clipPath={`url(#${clip}b)`} data-series="s2" />
          </>
        ) : (
          <path d={path} className={styles.line} />
        )}
        <circle cx={x(markI)} cy={y(markV)} r={2} className={baseline != null && markV < baseline ? styles.dotBelow : styles.dot} />
      </svg>
      <span className={styles.value}>{text}</span>
    </span>
  );
}

export const SparklineDemos: Array<{ name: string; props: SparklineProps }> = [
  { name: 'cpu', props: { label: 'CPU', points: [11, 12, 11, 10, 11, 18, 14, 11, 11, 12, 11, 10, 11, 11, 13, 11, 12, 11, 11, 11], readout: '11 %' } },
  { name: 'tokens', props: { label: '近 7 天 token', size: 'md', mark: 'max', points: [0.82, 1.1, 0.64, 0.95, 1.31, 0.22, 1.24], readout: '今天 1.24 M │ 峰 1.31 M' } },
  { name: 'emph', props: { label: '近 7 天 token', size: 'md', mark: 'max', emph: true, points: [0.82, 1.1, 0.64, 0.95, 1.31, 0.22, 1.24], readout: '今天 1.24 M │ 峰 1.31 M' } },
  { name: 'mood-negative', props: { label: '心情', size: 'md', baseline: 0, points: [0.18, 0.12, 0.05, -0.04, -0.1, -0.08, -0.12], readout: '−0.12 │ 基线 0' } },
  { name: 'step', props: { label: '精力', size: 'md', step: true, points: [0.62, 0.62, 0.48, 0.48, 0.53, 0.31, 0.31], readout: '0.31 │ 困' } },
  { name: 'gaps', props: { label: '帧率', points: [60, 59, null, null, 58, 60, 45, 59], readout: '59 fps' } },
  { name: 'flat-zero', props: { label: '失败次数', points: [0, 0, 0, 0, 0, 0, 0] } },
  { name: 'empty', props: { label: '近 7 天截图', points: [null, null, null], readout: '还没有记录' } },
];
