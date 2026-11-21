import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { ChartState, type ChartStatus } from './ChartState';
import { DataTable, TableToggle } from './ChartTable';
import { useWidth } from './useWidth';
import { clampN, cx, isZh, rulerTicks } from './v3';
import palette from './palette.module.css';
import s from './ChartBox.module.css';

/** Props every ChartBox chart takes. */
export interface ChartCommonProps {
  /** 数据状态，交给 ChartState */
  st?: ChartStatus;
  /** 空态文字：写原因 */
  empty?: string;
  /** 出错或断开时，旧数据的时间（epoch ms） */
  stoppedAt?: number;
  /** 出错时的重试 */
  onRetry?: () => void;
  /** aria-label 和读数的标题 */
  label?: string;
  /** 不起作用：图表不画角标 */
  frame?: boolean;
}

/** 「以表格查看」的表：第一列是名称，其余右对齐。 */
export interface TableSpec {
  cols: string[];
  rows: ReactNode[][];
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

/** Width that follows the parent (or `w`), plus the hover readout: `{ref, W, tip, show, hide}`. */
export function useChart(w?: number, fallback = 480) {
  const [ref, mw] = useWidth<HTMLDivElement>(fallback);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: { clientX: number; clientY: number }, content: ReactNode) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, content });
  };
  return { ref, W: w || mw, tip, show, hide: () => setTip(null) };
}

export type Chart = ReturnType<typeof useChart>;

/** Id for SVG defs (hatch pattern) that is valid inside `url(#…)`. */
export const useSvgId = () => `v3${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

/** Class for SVG text: 12 px when it holds Chinese. */
export const zh = (text: unknown, ...more: Array<string | false | undefined>) => cx(isZh(text) && s.zh, ...more) || undefined;

interface ChartBoxProps {
  /** `data-stub` name of the chart. */
  name: string;
  c: Chart;
  w?: number;
  h?: number;
  st?: ChartStatus;
  empty?: string;
  stoppedAt?: number;
  onRetry?: () => void;
  label?: string;
  frame?: boolean;
  table?: TableSpec;
  foot?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Frame of every chart: ChartState, table switch, hover readout and the legend below; stale data keeps all of them. */
export function ChartBox({ name, c, w, h, st = 'ok', empty, stoppedAt, onRetry, label = '', table, foot, className, style, children }: ChartBoxProps) {
  const [tb, setTb] = useState(false);
  const drawn = st === 'ok' || st === 'error' || st === 'disconnected';
  const tbl = tb && !!table && drawn;
  const tx = c.tip ? clampN(c.tip.x, 90, Math.max(90, c.W - 90)) : 0;
  return (
    <div ref={c.ref} data-stub={name} data-empty={st === 'empty' || undefined} data-table={tbl || undefined} className={cx(palette.palette, s.box, className)} style={{ width: w ?? '100%', ...style }} onMouseLeave={c.hide}>
      {table && drawn && (
        <TableToggle
          icon
          on={tb}
          onToggle={(on) => {
            setTb(on);
            c.hide();
          }}
        />
      )}
      <ChartState state={st} emptyText={empty ?? `${label}：没有数据`} stoppedAt={stoppedAt} onRetry={onRetry} height={h}>
        {tbl ? <DataTable caption={label} columns={table.cols.map((col, i) => ({ label: col, align: i ? 'right' : undefined }))} rows={table.rows.map((cells, i) => ({ key: String(i), cells }))} /> : children}
      </ChartState>
      {drawn && !tbl && foot}
      {c.tip && drawn && !tbl && (
        <div className={s.tip} role="tooltip" style={{ left: tx, top: c.tip.y }}>
          {c.tip.content}
        </div>
      )}
    </div>
  );
}

/** The `--ef-hatch` stripes as an SVG pattern, for gaps, paused spans and the hatch fill level. */
export function Hatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width="6.5" height="6.5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <rect width="1.5" height="6.5" className={s.hatchP} />
      </pattern>
    </defs>
  );
}

/** Time ruler along the bottom of an SVG plot. */
export function SvgRuler({ t0, t1, X, y, PW, fmtT }: { t0: number; t1: number; X: (t: number) => number; y: number; PW: number; fmtT?: (t: number) => string }) {
  const r = rulerTicks(t0, t1, PW);
  const f = fmtT ?? r.fmt;
  return (
    <g>
      {r.shorts.map((t) => (
        <line key={`s${t}`} x1={X(t)} x2={X(t)} y1={y} y2={y + 3} className={s.ax} />
      ))}
      {r.longs.map((t) => (
        <g key={`l${t}`}>
          <line x1={X(t)} x2={X(t)} y1={y} y2={y + 6} className={s.ax} />
          {r.lab(t) && (
            <text x={X(t) + 3} y={y + 15} className={zh(f(t))}>
              {f(t)}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}
