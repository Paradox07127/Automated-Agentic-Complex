import type { MouseEvent } from 'react';
import { Fragment, useEffect, useId, useState } from 'react';
import { formatClock } from '../domain';
import { ChartLegend } from './ChartLegend';
import { ChartTip, DataTable, TableToggle } from './ChartTable';
import { clamp, clockTickLabel, lastIndex, linePath, timeStep, timeTicks } from './scale';
import { ShapeGlyph } from './StateMark';
import { useWidth } from './useWidth';
import common from './chart.module.css';
import palette from './palette.module.css';
import styles from './SmallMultiples.module.css';

export interface MultipleSeries {
  key: string;
  label: string;
  unit: string;
  values: Array<number | null>;
  min: number;
  max: number;
  /** Budget line; points above it get ▲. */
  budget?: number;
  /** Target line (dashed), e.g. fps target. */
  target?: number;
}

/** 小倍图：多指标共用 x 轴、各自纵轴，不用双轴；画预算或目标线，超出画 ▲；暂停段灰带。 */
export interface SmallMultiplesProps {
  /** 每条一个指标 */
  series: MultipleSeries[];
  /** 第一个点的时间（epoch ms） */
  start: number;
  /** 点间隔 ms */
  stepMs: number;
  /** 读屏名称 */
  label: string;
  /** 暂停区间（点下标，含两端） */
  suspended?: Array<[number, number]>;
  /** 十字准线所在下标，三条同步 */
  cursor?: number | null;
  /** 点某一秒 */
  onPick?: (index: number) => void;
  /** 以表格查看（URL 可直接打开表格态） */
  table?: boolean;
  /** 要强调的指标 key：线用强调色，其余墨色灰阶 */
  emph?: string;
}

/** Width before the box is measured. */
const W0 = 660;
const H = 56;
const L = 52;
const R = 84;

/** Indexes whose value is above the series budget. */
export function overBudget(s: Pick<MultipleSeries, 'values' | 'budget'>): number[] {
  if (s.budget == null) return [];
  const b = s.budget;
  return s.values.flatMap((v, i) => (v != null && v > b ? [i] : []));
}

const fmtV = (v: number | null | undefined, unit: string) => (v == null ? '暂停' : `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}`);

export function SmallMultiples({ series, start, stepMs, label, suspended = [], cursor = null, onPick, table = false, emph }: SmallMultiplesProps) {
  const [tbl, setTbl] = useState(table);
  useEffect(() => setTbl(table), [table]);
  const [hover, setHover] = useState<number | null>(cursor);
  const [tipY, setTipY] = useState(0);
  const [box, W] = useWidth<HTMLElement>(W0);
  const PW = W - L - R;
  const uid = useId();
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const x = (i: number) => L + (n > 1 ? i / (n - 1) : 0.5) * PW;
  const timeOf = (i: number) => start + i * stepMs;
  const end = timeOf(n - 1);
  const step = timeStep(end - start);
  const ticks = timeTicks(start, end);
  const fallback = Math.max(0, ...series.map((s) => lastIndex(s.values)));
  const idx = hover ?? fallback;
  const isSuspended = (i: number) => suspended.some(([a, b]) => i >= a && i <= b);
  const overs = series.map(overBudget);

  const indexAt = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = r.width > 0 ? ((e.clientX - r.left) * W) / r.width : 0;
    return Math.round(clamp((vx - L) / PW, 0, 1) * (n - 1));
  };
  const onMove = (e: MouseEvent<SVGSVGElement>, row: number) => {
    setHover(indexAt(e));
    setTipY(row * (H + 4));
  };

  const strip = (s: MultipleSeries, row: number) => {
    const y = (v: number) => 5 + (1 - (clamp(v, s.min, s.max) - s.min) / (s.max - s.min || 1)) * (H - 10);
    const ref = s.budget ?? s.target;
    // 暂停 sits in the half away from the reference line and its label.
    const pauseY = ref != null && y(ref) < H / 2 ? H - 6 : 14;
    const v = s.values[idx];
    const li = lastIndex(s.values);
    const over = overs[row] ?? [];
    const tid = `${uid}${s.key}t`;
    const did = `${uid}${s.key}d`;
    const desc = `${formatClock(timeOf(idx), { seconds: true })} ${fmtV(v, s.unit)}${s.budget != null ? `，预算 ${s.budget}` : s.target != null ? `，目标 ${s.target}` : ''}${over.length ? `，超预算 ${over.length} 点` : ''}`;
    return (
      <Fragment key={s.key}>
        <span hidden>
          <span id={tid} data-chart-title="">
            {s.label}
          </span>
          <span id={did} data-chart-desc="">
            {desc}
          </span>
        </span>
        <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={tid} aria-describedby={did} data-series={s.key} data-emph={s.key === emph || undefined} onMouseMove={(e) => onMove(e, row)} onMouseLeave={() => setHover(cursor)} onClick={(e) => onPick?.(indexAt(e))}>
          <line className={styles.axis} x1={L} x2={L + PW} y1={H - 0.5} y2={H - 0.5} />
          {suspended.map(([a, b]) => (
            <g key={`${a}-${b}`}>
              <rect className={styles.suspended} x={x(a) - 2} width={x(b) - x(a) + 4} y={0} height={H} />
              {row === 0 && (
                <text className={styles.labelCn} x={(x(a) + x(b)) / 2} y={pauseY} textAnchor="middle">
                  暂停
                </text>
              )}
            </g>
          ))}
          {ref != null && (
            <>
              <line className={styles.ref} data-ref={s.budget != null ? 'budget' : 'target'} x1={L} x2={L + PW} y1={y(ref)} y2={y(ref)} />
              <text className={styles.labelCn} x={L + 4} y={y(ref) - 3}>
                {s.budget != null ? `预算 ${s.budget}` : `目标 ${s.target}`}
              </text>
            </>
          )}
          <path className={styles.line} d={linePath(s.values, x, y)} />
          {over.map((i) => (
            <text key={i} className={styles.tri} data-over={i} x={x(i)} y={y(s.values[i] ?? s.max) - 3} textAnchor="middle">
              ▲
            </text>
          ))}
          {li >= 0 && <circle className={styles.dot} cx={x(li)} cy={y(s.values[li] ?? 0)} r={2} />}
          {hover != null && <line className={styles.cursor} x1={x(idx)} x2={x(idx)} y1={0} y2={H} />}
          <text className={styles.name} x={0} y={H / 2 + 4}>
            {s.label}
          </text>
          <text className={styles.value} x={W} y={H / 2 + 5} textAnchor="end" data-over={(v != null && s.budget != null && v > s.budget) || undefined}>
            {v != null && s.budget != null && v > s.budget ? '▲ ' : ''}
            {fmtV(v, s.unit)}
          </text>
        </svg>
      </Fragment>
    );
  };

  const overTotal = overs.reduce((a, o) => a + o.length, 0);
  if (series.every((s) => lastIndex(s.values) < 0)) {
    return (
      <figure ref={box} data-stub="SmallMultiples" data-start={start} data-step={stepMs} data-empty="" className={styles.root}>
        <p className={common.emptyLine}>{label}：没有数据</p>
      </figure>
    );
  }
  const legend = [
    ...(series.some((s) => s.budget != null) ? [{ key: 'over', label: '超预算', count: overTotal, mark: <ShapeGlyph shape="triangle" token="--ef-state-warning" size={8} /> }] : []),
    ...(suspended.length > 0 ? [{ key: 'paused', label: '暂停', count: suspended.length, mark: <i className={styles.pausedSw} aria-hidden="true" /> }] : []),
  ];
  return (
    <figure ref={box} data-stub="SmallMultiples" data-start={start} data-step={stepMs} data-suspended={suspended.map((r) => r.join('-')).join(',') || undefined} data-cursor={hover ?? undefined} data-table={tbl || undefined} aria-label={label} className={`${palette.palette} ${styles.root}`}>
      <div className={common.head}>
        <span className={common.headText}>
          {label} │ <span className={common.num}>{formatClock(timeOf(idx), { seconds: true })}</span>
          {hover != null ? '（准线）' : ''}
        </span>
        <span className={common.spacer} />
        <TableToggle on={tbl} onToggle={setTbl} />
      </div>
      {tbl ? (
        <DataTable
          caption={label}
          columns={[{ label: '时间' }, ...series.map((s) => ({ label: `${s.label} ${s.unit}`, align: 'right' as const }))]}
          selected={hover != null ? String(hover) : null}
          onRow={(k) => onPick?.(Number(k))}
          rows={Array.from({ length: n }, (_, i) => n - 1 - i).map((i) => ({
            key: String(i),
            cells: [formatClock(timeOf(i), { seconds: true }), ...series.map((s) => (isSuspended(i) && s.values[i] == null ? '暂停' : `${(overs[series.indexOf(s)] ?? []).includes(i) ? '▲ ' : ''}${s.values[i] ?? '—'}`))],
          }))}
        />
      ) : (
        <div className={styles.plot}>
          {series.map(strip)}
          <svg className={styles.svg} viewBox={`0 0 ${W} 16`} aria-hidden="true">
            {ticks.map((t) => {
              const tx = x((t - start) / stepMs);
              return (
                <g key={t}>
                  <line className={styles.axis} x1={tx} x2={tx} y1={0} y2={4} />
                  <text className={styles.label} x={tx} y={14} textAnchor="middle">
                    {clockTickLabel(t, step)}
                  </text>
                </g>
              );
            })}
          </svg>
          {hover != null && (
            <ChartTip x={`${(x(idx) / W) * 100}%`} y={tipY} lines={[formatClock(timeOf(idx), { seconds: true }), ...series.slice(0, 3).map((s) => `${s.label} ${fmtV(s.values[idx], s.unit)}`)]} />
          )}
        </div>
      )}
      {!tbl && legend.length > 0 && <ChartLegend items={legend} />}
    </figure>
  );
}

const START = new Date(2026, 9, 29, 14, 31, 10).getTime();
/** 60 one-second samples with a spike at 22 s and the picture paused at 40–44 s. */
const sample = (base: number, spike: number, jitter: number) => Array.from({ length: 60 }, (_, i) => (i >= 40 && i <= 44 ? null : i === 22 || i === 23 ? spike : Math.round((base + Math.sin(i * 1.7) * jitter) * 10) / 10));
const RENDER: MultipleSeries[] = [
  { key: 'fps', label: '帧率', unit: 'fps', min: 30, max: 66, target: 60, values: sample(59.6, 45, 0.6) },
  { key: 'p95', label: 'P95', unit: 'ms', min: 0, max: 30, budget: 16.7, values: sample(15.5, 24.6, 0.4) },
  { key: 'gpu', label: 'GPU', unit: 'ms', min: 0, max: 16, budget: 8, values: sample(6.1, 11.8, 0.3) },
];

export const SmallMultiplesDemos: Array<{ name: string; props: SmallMultiplesProps }> = [
  { name: 'render', props: { label: '渲染 60 s', start: new Date(2026, 9, 29, 14, 31).getTime(), stepMs: 1000, suspended: [[4, 5]], series: [{ key: 'fps', label: '帧率', unit: 'fps', min: 30, max: 66, target: 60, values: [59, 60, 45, 59, null, null, 59] }, { key: 'p95', label: 'P95', unit: 'ms', min: 0, max: 30, budget: 16.7, values: [15.4, 15.6, 24.6, 15.8, null, null, 15.6] }, { key: 'gpu', label: 'GPU', unit: 'ms', min: 0, max: 16, budget: 8, values: [6.1, 6.3, 11.8, 6.0, null, null, 6.1] }] } },
  { name: 'minute', props: { label: '渲染 60 s', start: START, stepMs: 1000, suspended: [[40, 44]], series: RENDER } },
  { name: 'emph', props: { label: '渲染 60 s', start: START, stepMs: 1000, suspended: [[40, 44]], emph: 'p95', series: RENDER } },
  { name: 'cursor', props: { label: '渲染 60 s', start: START, stepMs: 1000, suspended: [[40, 44]], cursor: 22, series: RENDER } },
  { name: 'all-over', props: { label: 'GPU 超预算', start: START, stepMs: 1000, series: [{ key: 'gpu', label: 'GPU', unit: 'ms', min: 0, max: 16, budget: 8, values: [9.2, 10.1, 12.4, 16, 18.3, 11] }] } },
  { name: 'table', props: { label: '渲染 60 s', start: START, stepMs: 1000, suspended: [[40, 44]], series: RENDER, table: true } },
  { name: 'paused', props: { label: '渲染暂停', start: START, stepMs: 1000, suspended: [[0, 5]], series: [{ key: 'fps', label: '帧率', unit: 'fps', min: 30, max: 66, target: 60, values: [null, null, null, null, null, null] }] } },
];
