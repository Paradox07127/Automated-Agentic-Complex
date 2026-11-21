import { ChartBox, useChart, type ChartCommonProps } from './ChartBox';
import { cx, sum } from './v3';
import s from './ChartBox.module.css';
import d from './DivergingBar.module.css';

/** 增删分向条：向左删、向右增，墨色阶，emph 行用 trace；右侧写 −n / +n，底部写合计。 */
export interface DivergingBarProps extends ChartCommonProps {
  rows: Array<{ label: string; neg: number; pos: number }>;
  w?: number;
  /** 名称列宽，默认 200 */
  labelW?: number;
  /** 要强调的行 label */
  emph?: string;
}

export function DivergingBar({ rows, w, labelW = 200, label = '增删', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: DivergingBarProps) {
  const c = useChart(w);
  if (!rows.length && st === 'ok') st = 'empty';
  const lw = Math.min(labelW, Math.round(c.W * 0.4));
  const mx = Math.max(1, ...rows.map((r) => Math.max(r.neg || 0, r.pos || 0)));
  const tn = sum(rows.map((r) => r.neg));
  const tp = sum(rows.map((r) => r.pos));
  const aria = `${label}：${rows.map((r) => `${r.label} 删 ${r.neg || 0} 增 ${r.pos || 0}`).join('，')}`;
  const foot = (
    <div className={s.lg}>
      <span>
        合计 <span className={cx(s.num, d.dan)}>−{tn}</span> / <span className={cx(s.num, d.suc)}>+{tp}</span>
      </span>
      <span className={s.t3}>向左删 │ 向右增</span>
    </div>
  );
  const table = { cols: ['文件', '删', '增'], rows: rows.map((r) => [r.label, `−${r.neg || 0}`, `+${r.pos || 0}`]) };
  return (
    <ChartBox name="DivergingBar" c={c} w={w} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} foot={foot} h={rows.length * 20} table={table} frame={frame}>
      <div className={d.dv} role="img" aria-label={aria} style={{ ['--lw' as string]: `${lw}px` }}>
        {rows.map((r, i) => (
          <div key={i} className={cx(d.row, r.label === emph && d.em)} data-row={r.label} onMouseMove={(e) => c.show(e, `${r.label}\n删 ${r.neg || 0} 行 │ 增 ${r.pos || 0} 行`)}>
            <span className={d.label} title={r.label}>
              <bdi>{r.label}</bdi>
            </span>
            <span className={cx(d.half, d.neg)}>
              <i style={{ width: `${((r.neg || 0) / mx) * 100}%` }} />
            </span>
            <span className={cx(d.half, d.pos)}>
              <i style={{ width: `${((r.pos || 0) / mx) * 100}%` }} />
            </span>
            <span className={cx(d.v, s.num)}>
              <span className={d.dan}>−{r.neg || 0}</span> <span className={d.suc}>+{r.pos || 0}</span>
            </span>
          </div>
        ))}
      </div>
    </ChartBox>
  );
}

const FILES = [
  { label: 'Sources/CompanionCore/HostLink.swift', neg: 6, pos: 3 },
  { label: 'Sources/CompanionCore/Reconnect.swift', neg: 0, pos: 48 },
  { label: 'Tests/CompanionCoreTests/HostLinkTests.swift', neg: 2, pos: 31 },
  { label: 'Sources/CompanionUI/StatusBar.swift', neg: 12, pos: 4 },
];

export const DivergingBarDemos: Array<{ name: string; props: DivergingBarProps }> = [
  { name: 'files', props: { label: '文件增删', rows: FILES, labelW: 120, emph: 'Sources/CompanionCore/Reconnect.swift' } },
  { name: 'plain', props: { label: '文件增删', rows: FILES.slice(0, 2) } },
  { name: 'empty', props: { label: '文件增删', empty: '这次运行没有改动文件', rows: [] } },
];
