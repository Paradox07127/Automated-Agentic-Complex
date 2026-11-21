import { ChartBox, useChart, type ChartCommonProps } from './ChartBox';
import { play } from './v3demo';
import { clampN, cx, EMPH, INK, pad2, paint, sum } from './v3';
import s from './ChartBox.module.css';
import m from './DotMatrix.module.css';

/** 按小时点阵：0 画空格，其余按 v/max 调透明度；emph 行、emphCol 列用强调色；futureFrom 起画斜纹表示还没到。 */
export interface DotMatrixProps extends ChartCommonProps {
  /** 列数，默认 24 */
  cols?: number;
  rows: Array<{ label: string; vals: number[] }>;
  max?: number;
  color?: string;
  fmt?: (v: number) => string;
  colLabel?: (i: number) => string;
  /** 格子边长上限，默认 12；随宽度缩小 */
  cell?: number;
  /** 名称列宽，默认 64 */
  labelW?: number;
  /** 要强调的行 label */
  emph?: string;
  /** 强调的列下标，并在轴上标出 */
  emphCol?: number;
  /** 从这一列起还没到 */
  futureFrom?: number;
}

export function DotMatrix({ cols = 24, rows, max, color, fmt = (v) => `${v} 次`, colLabel = (i) => `${pad2(i)}:00`, cell = 12, labelW = 64, label = '点阵', st = 'ok', empty, stoppedAt, onRetry, emph, emphCol, futureFrom, frame }: DotMatrixProps) {
  const c = useChart();
  if (!rows.length && st === 'ok') st = 'empty';
  const mx = max ?? Math.max(1, ...rows.flatMap((r) => r.vals));
  const lw = Math.min(labelW, Math.round(c.W * 0.25));
  const cl = clampN(Math.floor((c.W - lw - 64 - (cols - 1) * 2) / cols), 3, cell);
  const peakOf = (vals: number[]) => colLabel(vals.indexOf(Math.max(...vals)));
  const aria = `${label}：${rows.map((r) => `${r.label} 合计 ${fmt(sum(r.vals))}，峰值 ${peakOf(r.vals)}`).join('；')}`;
  const tickEvery = cl * cols < 200 ? 12 : 6;
  const fu = (i: number) => futureFrom != null && i >= futureFrom;
  const idx = Array.from({ length: cols }, (_, i) => i);
  const tick = (i: number) => i === emphCol || (i % tickEvery === 0 && (emphCol == null || Math.abs(i - emphCol) > 2));
  const table = { cols: ['', ...rows.map((r) => r.label)], rows: idx.map((i) => [colLabel(i), ...rows.map((r) => (fu(i) ? '—' : String(r.vals[i] ?? 0)))]) };
  return (
    <ChartBox name="DotMatrix" c={c} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} h={rows.length * (cl + 3) + 16} table={table} frame={frame}>
      <div className={m.dm} role="img" aria-label={aria} style={{ ['--lw' as string]: `${lw}px`, ['--cell' as string]: `${cl}px`, ['--cols' as string]: cols }}>
        {rows.map((r) => {
          const col = r.label === emph ? EMPH : (paint(color) ?? INK[rows.some((x) => x.label === emph) ? 1 : 0]);
          return (
            <div key={r.label} className={cx(m.row, r.label === emph && m.em)} data-row={r.label}>
              <span className={m.label}>{r.label}</span>
              <span className={m.cells}>
                {idx.map((i) => {
                  const v = fu(i) ? 0 : (r.vals[i] ?? 0);
                  const ec = i === emphCol;
                  return <i key={i} className={cx(!v && m.z, fu(i) && m.fu, ec && m.ec)} style={v ? { background: ec ? EMPH : col, opacity: 0.25 + 0.75 * Math.min(1, v / mx) } : undefined} onMouseMove={(e) => c.show(e, `${r.label}\n${colLabel(i)} │ ${fu(i) ? '还没到' : fmt(v)}`)} />;
                })}
              </span>
              <span className={cx(m.v, s.num)}>{fmt(sum(r.vals))}</span>
            </div>
          );
        })}
        <div className={m.row}>
          <span />
          <span className={m.cells}>
            {idx.map((i) => (
              <b key={i} className={i === emphCol ? m.ec : undefined}>
                {tick(i) ? pad2(i) : ''}
              </b>
            ))}
          </span>
          <span />
        </div>
      </div>
    </ChartBox>
  );
}

const PLAYS = [
  { label: '点头附和', vals: play(6) },
  { label: '开口说话', vals: play(9) },
  { label: '思考', vals: play(3) },
  { label: '走动', vals: play(4) },
];

export const DotMatrixDemos: Array<{ name: string; props: DotMatrixProps }> = [
  { name: 'emph', props: { label: '今天动作播放', rows: PLAYS, cell: 8, emph: '开口说话' } },
  { name: 'now', props: { label: '出错按小时', rows: [{ label: '出错', vals: Array.from({ length: 24 }, (_, h) => ({ 10: 1, 12: 3, 14: 1 })[h] ?? 0) }], color: 'var(--ef-ink-s2)', cell: 8, emphCol: 14, futureFrom: 15 } },
  { name: 'empty', props: { label: '今天动作播放', empty: '今天还没有播放动作', rows: [] } },
];
