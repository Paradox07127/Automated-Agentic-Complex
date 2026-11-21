import type { MouseEvent } from 'react';
import { useRef, useState } from 'react';
import { formatClock, formatMs, stateVisual, type TurnDot, type TurnResult } from '../domain';
import { useChartLabel } from './ChartLabel';
import { ChartLegend } from './ChartLegend';
import { ChartTip, DataTable, TableToggle } from './ChartTable';
import { clamp, clockTickLabel, LOG_TICKS_MS, logPos, logTickLabel, timeStep, timeTicks } from './scale';
import { SHAPE_CHAR } from './StateMark';
import { useWidth } from './useWidth';
import common from './chart.module.css';
import palette from './palette.module.css';
import styles from './DotStrip.module.css';

/** 结果散点条带：log y 轴（100 ms / 1 s / 10 s / 1 min），结果按形状编码，底部 8 px 每小时失败小柱；可横向刷选。 */
export interface DotStripProps {
  /** 点 */
  dots: TurnDot[];
  /** 时间轴起点（epoch ms） */
  start: number;
  /** 时间轴终点（epoch ms） */
  end: number;
  /** 读屏名称 */
  label: string;
  /** 每小时失败数（底部小柱，间隔 2 px） */
  failuresPerHour?: number[];
  /** 刷选区间 */
  brush?: [number, number] | null;
  /** 截断说明，例如「只显示最新 200 轮」 */
  note?: string;
  /** 以表格查看 */
  table?: boolean;
  /** 点点 */
  onPick?: (id: string) => void;
  /** 刷选 */
  onBrush?: (range: [number, number] | null) => void;
  /** 要强调的点 id：画强调色 */
  emph?: string;
}

const H = 120;
const L = 52;
const R = 8;
const TOP = 6;
const PLOT = 70;
const BAND_Y = 89;
const AXIS_Y = 101;
const HOUR = 3_600_000;
const ORDER: TurnResult[] = ['failed', 'interrupted', 'running', 'ok', 'skipped', 'unknown'];

/** Width before the box is measured (jsdom, first paint). */
const W0 = 1024;

/** Result label as used in legend, table and tooltip (three channels from `stateVisual`). */
export function resultText(r: TurnResult): string {
  const v = stateVisual(r);
  return `${SHAPE_CHAR[r === 'ok' ? 'square' : v.shape]} ${r === 'interrupted' ? '打断' : v.label}`;
}

/** Failures per hour slot from `start`; the explicit series wins when given. */
export function hourlyFailures(dots: ReadonlyArray<TurnDot>, start: number, end: number, given: ReadonlyArray<number> = []): number[] {
  if (given.length > 0) return [...given];
  const n = Math.max(1, Math.ceil((end - start) / HOUR));
  const out = Array.from({ length: n }, () => 0);
  for (const d of dots) {
    const i = Math.floor((d.started_at - start) / HOUR);
    if (d.result === 'failed' && i >= 0 && i < n) out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

function Dot({ result, x, y, on, em }: { result: TurnResult; x: number; y: number; on?: boolean; em?: boolean }) {
  const cls = `${styles.dot} ${on ? styles.on : ''} ${em ? styles.em : ''}`;
  if (result === 'failed') return <rect className={cls} data-result={result} x={x - 3} y={y - 3} width={6} height={6} />;
  if (result === 'interrupted') return <rect className={cls} data-result={result} x={x - 2.75} y={y - 2.75} width={5.5} height={5.5} />;
  if (result === 'running') return <circle className={cls} data-result={result} cx={x} cy={y} r={3.2} />;
  if (result === 'skipped') return <circle className={cls} data-result={result} cx={x} cy={y} r={1.6} />;
  if (result === 'unknown') return <path className={cls} data-result={result} d={`M${x} ${y - 3} l3 5 h-6 Z`} />;
  return <rect className={cls} data-result={result} x={x - 1.5} y={y - 1.5} width={on ? 4 : 3} height={on ? 4 : 3} />;
}

export function DotStrip({ dots, start, end, label, failuresPerHour = [], brush = null, note, table = false, onPick, onBrush, emph }: DotStripProps) {
  const [tbl, setTbl] = useState(table);
  const [range, setRange] = useState<[number, number] | null>(brush);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<{ dot: TurnDot; px: number; py: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const from = useRef<number | null>(null);
  const [box, W] = useWidth<HTMLElement>(W0);
  const span = Math.max(1, end - start);
  const X = (t: number) => L + clamp((t - start) / span, 0, 1) * (W - L - R);
  const Y = (ms: number) => TOP + (1 - logPos(ms)) * PLOT;
  const fails = hourlyFailures(dots, start, end, failuresPerHour);
  const fmax = Math.max(1, ...fails);
  const step = timeStep(span);
  const ticks = timeTicks(start, end);
  const counts = ORDER.map((r) => [r, dots.filter((d) => d.result === r).length] as const).filter(([r, count]) => r !== 'unknown' || count > 0);
  const sorted = [...dots].sort((a, b) => a.started_at - b.started_at);

  const toView = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = r.width > 0 ? W / r.width : 1;
    const sy = r.height > 0 ? H / r.height : 1;
    return { vx: (e.clientX - r.left) * sx, vy: (e.clientY - r.top) * sy, px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const timeAt = (vx: number) => start + clamp((vx - L) / (W - L - R), 0, 1) * span;
  const nearest = (vx: number, vy: number) => {
    let best: TurnDot | null = null;
    let bd = 14;
    for (const d of dots) {
      const dist = Math.hypot(X(d.started_at) - vx, Y(d.duration_ms) - vy);
      if (dist < bd) {
        bd = dist;
        best = d;
      }
    }
    return best;
  };
  const onDown = (e: MouseEvent<SVGSVGElement>) => {
    from.current = timeAt(toView(e).vx);
  };
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const p = toView(e);
    if (from.current != null) {
      const t = timeAt(p.vx);
      if (Math.abs(X(t) - X(from.current)) > 4) setDrag([Math.min(t, from.current), Math.max(t, from.current)]);
      return;
    }
    const d = nearest(p.vx, p.vy);
    setHover(d ? { dot: d, px: p.px, py: p.py } : null);
  };
  const onUp = (e: MouseEvent<SVGSVGElement>) => {
    const p = toView(e);
    from.current = null;
    if (drag) {
      setRange(drag);
      onBrush?.(drag);
      setDrag(null);
      return;
    }
    const d = nearest(p.vx, p.vy);
    if (d) {
      setPicked(d.id);
      onPick?.(d.id);
    }
  };
  const clear = () => {
    setRange(null);
    onBrush?.(null);
  };
  const shown = drag ?? range;
  const inRange = range ? dots.filter((d) => d.started_at >= range[0] && d.started_at <= range[1]).length : null;
  const lbl = useChartLabel(label, `${dots.length} 轮，${counts.map(([r, n]) => `${resultText(r).slice(2)} ${n}`).join('，')}`);

  if (dots.length === 0) {
    return (
      <figure ref={box} data-stub="DotStrip" data-start={start} data-end={end} data-empty="" className={styles.root}>
        <p className={common.emptyLine}>{label}：没有轮次</p>
      </figure>
    );
  }

  return (
    <figure ref={box} data-stub="DotStrip" data-start={start} data-end={end} data-brush={range?.join('-')} data-table={tbl || undefined} aria-label={label} className={`${palette.palette} ${styles.root}`}>
      <div className={common.head}>
        <span className={common.spacer} />
        {range && (
          <span className={styles.brushInfo}>
            已选 {formatClock(range[0])}–{formatClock(range[1])} │ <span className={common.num}>{inRange}</span> 轮
            <button type="button" className={common.tableToggle} onClick={clear}>
              清除
            </button>
          </span>
        )}
        <TableToggle on={tbl} onToggle={setTbl} />
      </div>
      {tbl ? (
        <DataTable
          caption={label}
          columns={[{ label: '时间' }, { label: '来源' }, { label: '耗时', align: 'right' }, { label: '结果' }]}
          selected={picked}
          onRow={(k) => {
            setPicked(k);
            onPick?.(k);
          }}
          rows={sorted.map((d) => ({ key: d.id, cells: [formatClock(d.started_at, { seconds: true }), d.source, formatMs(d.duration_ms), resultText(d.result)] }))}
        />
      ) : (
        <div className={styles.plot}>
          {lbl.text}
          <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} {...lbl.img} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => { from.current = null; setDrag(null); setHover(null); }}>
            {LOG_TICKS_MS.map((ms) => (
              <g key={ms}>
                <line className={styles.grid} x1={L} x2={W - R} y1={Y(ms)} y2={Y(ms)} />
                <text className={styles.label} x={L - 6} y={Y(ms) + 4} textAnchor="end">
                  {logTickLabel(ms)}
                </text>
              </g>
            ))}
            {shown && <rect className={styles.brush} x={X(shown[0])} y={0} width={Math.max(1, X(shown[1]) - X(shown[0]))} height={TOP + PLOT + 4} />}
            {dots.map((d) => (
              <Dot key={d.id} result={d.result} x={X(d.started_at)} y={Y(d.duration_ms)} on={hover?.dot.id === d.id || picked === d.id} em={d.id === emph} />
            ))}
            {fails.map((f, i) => {
              if (f <= 0) return null;
              const x0 = X(start + i * HOUR);
              const x1 = X(start + (i + 1) * HOUR);
              const h = Math.max(2, (8 * f) / fmax);
              return <rect key={i} className={styles.failBar} data-count={f} x={x0 + 1} y={BAND_Y + 8 - h} width={Math.max(1, x1 - x0 - 2)} height={h} />;
            })}
            <text className={styles.labelCn} x={L - 6} y={BAND_Y + 8} textAnchor="end">
              失败
            </text>
            <line className={styles.axis} x1={L} x2={W - R} y1={AXIS_Y} y2={AXIS_Y} />
            {ticks.map((t) => (
              <g key={t}>
                <line className={styles.axis} x1={X(t)} x2={X(t)} y1={AXIS_Y} y2={AXIS_Y + 4} />
                <text className={styles.label} x={X(t)} y={H - 4} textAnchor="middle">
                  {clockTickLabel(t, step)}
                </text>
              </g>
            ))}
          </svg>
          {hover && !drag && <ChartTip x={hover.px} y={hover.py} lines={[`${hover.dot.source} │ ${formatClock(hover.dot.started_at, { seconds: true })}`, `耗时 ${formatMs(hover.dot.duration_ms)}`, resultText(hover.dot.result)]} />}
        </div>
      )}
      <ChartLegend
        items={counts.map(([r, n]) => ({
          key: r,
          label: resultText(r).slice(2),
          count: n,
          mark: (
            <svg className={styles.lg} width={8} height={8} viewBox="0 0 8 8" aria-hidden="true">
              <Dot result={r} x={4} y={4} />
            </svg>
          ),
        }))}
      />
      {note && <figcaption className={styles.note}>{note}</figcaption>}
    </figure>
  );
}

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 29, h, m, s).getTime();

/** Deterministic demo dots: 120 turns over the day with a few failures and interrupts. */
function demoDots(): TurnDot[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const sources = ['对话', '语音', '观察摘要', '动作决策'];
  return Array.from({ length: 120 }, (_, i) => {
    const r = rnd();
    const result: TurnResult = i === 119 ? 'running' : r < 0.05 ? 'failed' : r < 0.09 ? 'interrupted' : r < 0.14 ? 'skipped' : 'ok';
    return { id: `d${i}`, started_at: at(0, 0) + Math.floor(rnd() * (at(14, 30) - at(0, 0))), duration_ms: Math.round(10 ** (2.1 + rnd() * 2.4)), result, source: sources[i % sources.length] ?? '对话' };
  });
}

export const DotStripDemos: Array<{ name: string; props: DotStripProps }> = [
  { name: 'day', props: { label: '最近 24 h 轮次', start: at(0, 0), end: at(14, 32), failuresPerHour: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], dots: [{ id: 'tr5', started_at: at(14, 24), duration_ms: 900, result: 'failed', source: '观察摘要' }, { id: 'tr3', started_at: at(14, 29), duration_ms: 6200, result: 'ok', source: '对话' }, { id: 'tr6', started_at: at(14, 28), duration_ms: 3100, result: 'interrupted', source: '语音' }] } },
  { name: 'dense', props: { label: '今天的轮次', start: at(0, 0), end: at(14, 32), dots: demoDots(), note: '只显示最新 200 轮' } },
  { name: 'emph', props: { label: '最近 24 h 轮次', start: at(0, 0), end: at(14, 32), emph: 'tr3', dots: [{ id: 'tr5', started_at: at(14, 24), duration_ms: 900, result: 'failed', source: '观察摘要' }, { id: 'tr3', started_at: at(14, 29), duration_ms: 6200, result: 'ok', source: '对话' }, { id: 'tr2', started_at: at(13, 10), duration_ms: 2100, result: 'ok', source: '语音' }] } },
  { name: 'brushed', props: { label: '今天的轮次', start: at(0, 0), end: at(14, 32), dots: demoDots(), brush: [at(9, 0), at(11, 30)] } },
  { name: 'table', props: { label: '最近 24 h 轮次', table: true, start: at(14, 0), end: at(14, 32), dots: [{ id: 'tr5', started_at: at(14, 24), duration_ms: 900, result: 'failed', source: '观察摘要' }, { id: 'tr6', started_at: at(14, 28), duration_ms: 3100, result: 'interrupted', source: '语音' }, { id: 'tr7', started_at: at(14, 31), duration_ms: 120_000, result: 'running', source: '对话' }] } },
  { name: 'empty', props: { label: '今天的轮次', start: at(0, 0), end: at(14, 32), dots: [] } },
];
