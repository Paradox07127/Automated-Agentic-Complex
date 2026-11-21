import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import { formatDuration, formatMs, stateVisual, type TurnStage } from '../domain';
import { useChartLabel } from './ChartLabel';
import { ChartLegend, type LegendItem } from './ChartLegend';
import { DataTable, TableToggle } from './ChartTable';
import { fraction, offsetTickLabel, offsetTicks } from './scale';
import { SHAPE_CHAR, StateMark } from './StateMark';
import common from './chart.module.css';
import palette from './palette.module.css';
import styles from './Waterfall.module.css';

export interface WaterfallRow {
  id: string;
  label: string;
  stages: TurnStage[];
  /** 这条泳道自己的终止节点（每次运行各自成败）；不给时最后一行用 `terminal` */
  terminal?: 'ok' | 'failed' | null;
}

/** 瀑布：底 chart-bg，已完成次墨、当前段墨色亮端、失败黄旗、打断 □；关键时刻竖虚线；选中段 trace 描边；图例在图下带计数；带表格视图。 */
export interface WaterfallProps {
  /** 行：每个 generation 一条泳道，或一轮的各阶段 */
  rows: WaterfallRow[];
  /** 时间轴总长（ms），偏移都相对起点 */
  totalMs: number;
  /** 读屏名称 */
  label: string;
  /** 工具刻度（8 高）；`highlight` 的刻度画主序列色，其余变淡 */
  ticks?: Array<{ row: string; atMs: number; durationMs: number; label: string; highlight?: boolean }>;
  /** 关键时刻竖线，例如「首字 1.24 s（模型后 0.86 s）」 */
  marks?: Array<{ atMs: number; label: string }>;
  /** 整体结果（页头读数，也是最后一行的默认终止节点）：成功 ✓、失败 ✕ */
  terminal?: 'ok' | 'failed' | null;
  /** 选中段 */
  selected?: { row: string; index: number } | null;
  /** 以表格查看 */
  table?: boolean;
  /** 点段 */
  onPick?: (row: string, index: number) => void;
  /** 要强调的行 id：这一行的段用强调色，其余墨色灰阶 */
  emph?: string;
}

export interface WaterfallSegment {
  row: string;
  rowLabel: string;
  index: number;
  stage: TurnStage;
  /** Status text for tables and tooltips; an interrupt names its mark, e.g. 「□ 打断 · ptt」. */
  status: string;
}

/** Every stage as drawn, row by row. */
export function waterfallSegments(rows: ReadonlyArray<WaterfallRow>, marks: ReadonlyArray<{ atMs: number; label: string }> = []): WaterfallSegment[] {
  return rows.flatMap((r) =>
    r.stages.map((s, index) => {
      const v = stateVisual(s.status);
      const endMark = s.status === 'interrupted' ? marks.find((m) => Math.abs(m.atMs - (s.start_ms + s.duration_ms)) <= 1) : undefined;
      return { row: r.id, rowLabel: r.label, index, stage: s, status: `${SHAPE_CHAR[v.shape]} ${endMark ? endMark.label : v.label}` };
    }),
  );
}

/** Stage length: `ms`/`s` under a minute, `m` above (domain formatters). */
export function stageDuration(ms: number): string {
  return ms < 60_000 ? formatMs(ms) : formatDuration(ms);
}

/** Wall time a row covers: first start to last end. */
export function rowSpan(r: WaterfallRow): number {
  if (r.stages.length === 0) return 0;
  return Math.max(...r.stages.map((s) => s.start_ms + s.duration_ms)) - Math.min(...r.stages.map((s) => s.start_ms));
}

const LEGEND: Array<[TurnStage['status'], string]> = [
  ['done', '已完成'],
  ['current', '当前'],
  ['failed', '失败'],
  ['interrupted', '打断'],
];

/** Legend items: one per stage status present, with the drawn swatch. */
export function waterfallLegend(segs: ReadonlyArray<WaterfallSegment>): LegendItem[] {
  return LEGEND.flatMap(([status, label]) => {
    const count = segs.filter((s) => s.stage.status === status).length;
    return count > 0 ? [{ key: status, label, count, mark: <i className={styles.sw} data-status={status} aria-hidden="true" /> }] : [];
  });
}

export function Waterfall({ rows, totalMs, label, ticks = [], marks = [], terminal = null, selected = null, table = false, onPick, emph }: WaterfallProps) {
  const [tbl, setTbl] = useState(table);
  const segs = waterfallSegments(rows, marks);
  const span = Math.max(1, totalMs, ...segs.map((s) => s.stage.start_ms + s.stage.duration_ms));
  const longest = segs.reduce<WaterfallSegment | null>((a, s) => (a == null || s.stage.duration_ms > a.stage.duration_ms ? s : a), null);
  const [sel, setSel] = useState<{ row: string; index: number } | null>(selected);
  const selKey = sel ? `${sel.row}:${sel.index}` : null;
  const selSeg = segs.find((s) => `${s.row}:${s.index}` === selKey);
  const X = (ms: number) => fraction(ms, span);
  const axis = offsetTicks(span);
  const pick = (s: WaterfallSegment) => {
    setSel({ row: s.row, index: s.index });
    onPick?.(s.row, s.index);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) || segs.length === 0) return;
    e.preventDefault();
    const i = segs.findIndex((s) => `${s.row}:${s.index}` === selKey);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = segs[Math.max(0, Math.min(segs.length - 1, i < 0 ? 0 : i + d))];
    if (next) pick(next);
  };
  const tip = (s: WaterfallSegment) => `${s.rowLabel} │ ${s.stage.name}\n+${offsetTickLabel(s.stage.start_ms, span)} │ ${stageDuration(s.stage.duration_ms)}\n${s.status}`;
  const lastRow = rows.at(-1);
  const anyHl = ticks.some((tk) => tk.highlight);
  const endOf = (id: string) => Math.max(...segs.filter((s) => s.row === id).map((s) => s.stage.start_ms + s.stage.duration_ms), 0);
  const legend = waterfallLegend(segs);
  const lbl = useChartLabel(label, `${segs.length} 个阶段，总 ${stageDuration(totalMs)}${longest ? `，最慢 ${longest.stage.name} ${stageDuration(longest.stage.duration_ms)}` : ''}${terminal ? `，${terminal === 'ok' ? '成功' : '失败'}` : ''}`);
  if (segs.length === 0) {
    return (
      <figure data-stub="Waterfall" data-total={totalMs} data-empty="" className={styles.root}>
        <p className={common.emptyLine}>{label}：还没有阶段</p>
      </figure>
    );
  }
  return (
    <figure data-stub="Waterfall" data-total={totalMs} data-terminal={terminal ?? undefined} data-selected={selKey ?? undefined} data-table={tbl || undefined} aria-label={label} className={`${palette.palette} ${styles.root}`}>
      <div className={common.head}>
        <span className={common.headText}>
          总 <span className={common.num}>{stageDuration(totalMs)}</span>
          {longest && (
            <>
              {' '}
              │ 最慢：{longest.stage.name} <span className={common.num}>{stageDuration(longest.stage.duration_ms)}</span>
            </>
          )}
          {terminal && <> │ {terminal === 'ok' ? '✓ 成功' : '✕ 失败'}</>}
        </span>
        <span className={common.spacer} />
        <TableToggle on={tbl} onToggle={setTbl} />
      </div>
      {tbl ? (
        <DataTable
          caption={label}
          columns={[{ label: '行' }, { label: '阶段' }, { label: '开始' }, { label: '时长', align: 'right' }, { label: '状态' }]}
          selected={selKey}
          onRow={(k) => {
            const s = segs.find((x) => `${x.row}:${x.index}` === k);
            if (s) pick(s);
          }}
          rows={segs.map((s) => ({
            key: `${s.row}:${s.index}`,
            cells: [s.rowLabel, s.stage.name, `+${offsetTickLabel(s.stage.start_ms, span)}`, stageDuration(s.stage.duration_ms), <StateMark key="s" state={s.stage.status} label={s.status.slice(2)} />],
          }))}
        />
      ) : (
        <div className={styles.grid} role="group" tabIndex={0} aria-label={`${label}，方向键在段间移动`} onKeyDown={onKey}>
          {marks.length > 0 && (
            <div className={styles.row} aria-hidden="true">
              <span />
              <div className={styles.marks}>
                {marks.map((m) => (
                  <span key={m.label} className={styles.markLabel} style={{ left: `${X(m.atMs) * 100}%` }} data-edge={X(m.atMs) > 0.75 ? 'end' : undefined}>
                    {m.label}
                  </span>
                ))}
              </div>
              <span />
            </div>
          )}
          {rows.map((r) => {
            const rowTicks = ticks.filter((tk) => tk.row === r.id);
            const end = r.terminal !== undefined ? r.terminal : r === lastRow ? terminal : null;
            return (
              <div key={r.id} className={styles.row} data-emph={r.id === emph || undefined}>
                <span className={styles.rowLabel} title={r.label}>
                  {r.label}
                </span>
                <div className={styles.track} data-tools={rowTicks.length > 0 || undefined}>
                  {marks.map((m) => (
                    <i key={m.label} className={styles.markLine} style={{ left: `${X(m.atMs) * 100}%` }} />
                  ))}
                  {segs
                    .filter((s) => s.row === r.id)
                    .map((s) => (
                      <button
                        key={s.index}
                        type="button"
                        tabIndex={-1}
                        className={`${styles.seg} ${common.tip}`}
                        data-status={s.stage.status}
                        data-selected={`${s.row}:${s.index}` === selKey || undefined}
                        data-start={s.stage.start_ms}
                        data-duration={s.stage.duration_ms}
                        data-tip={tip(s)}
                        aria-label={tip(s).replace(/\n/g, '，')}
                        style={{ left: `${X(s.stage.start_ms) * 100}%`, width: `max(3px, calc(${X(s.stage.duration_ms) * 100}% - 2px))` }}
                        onClick={() => pick(s)}
                      />
                    ))}
                  {rowTicks.map((tk) => (
                    <i key={`${tk.atMs}-${tk.label}`} className={`${styles.tool} ${common.tip}`} data-hl={anyHl ? (tk.highlight ? 'on' : 'off') : undefined} data-tip={`${tk.label}\n+${offsetTickLabel(tk.atMs, span)} │ ${stageDuration(tk.durationMs)}`} style={{ left: `${X(tk.atMs) * 100}%`, width: `max(2px, ${X(tk.durationMs) * 100}%)` }} />
                  ))}
                  {end && (
                    <span className={styles.terminal} data-terminal={end} role="img" aria-label={`${r === lastRow ? '最终' : r.label}${end === 'ok' ? '成功' : '失败'}`} style={{ left: `${X(endOf(r.id)) * 100}%` }}>
                      {end === 'ok' ? '✓' : '✕'}
                    </span>
                  )}
                </div>
                <span className={styles.rowValue}>{stageDuration(rowSpan(r))}</span>
              </div>
            );
          })}
          {lbl.text}
          <div className={styles.row} {...lbl.img}>
            <span />
            <div className={styles.axis}>
              {axis.map((ms) => (
                <span key={ms} className={styles.tick} style={{ left: `${X(ms) * 100}%` }}>
                  {offsetTickLabel(ms, span)}
                </span>
              ))}
            </div>
            <span />
          </div>
        </div>
      )}
      {!tbl && legend.length > 0 && <ChartLegend items={legend} />}
      {selSeg && (
        <p className={styles.selLine} aria-live="polite">
          <b>{selSeg.stage.name}</b> │ <span className={common.num}>+{offsetTickLabel(selSeg.stage.start_ms, span)} │ {stageDuration(selSeg.stage.duration_ms)}</span> │ {selSeg.status}
        </p>
      )}
    </figure>
  );
}

const stage = (name: string, start_ms: number, duration_ms: number, status: TurnStage['status']): TurnStage => ({ name, start_ms, duration_ms, status });
const MIN = 60_000;

export const WaterfallDemos: Array<{ name: string; props: WaterfallProps }> = [
  {
    name: 'turn',
    props: {
      label: '轮次瀑布',
      totalMs: 3100,
      rows: [
        { id: 'in', label: '接收输入', stages: [stage('接收输入', 0, 80, 'done')] },
        { id: 'ctx', label: '读取上下文', stages: [stage('读取上下文', 80, 300, 'done')] },
        { id: 'model', label: '模型调用', stages: [stage('模型调用', 380, 2400, 'done')] },
        { id: 'tts', label: '播报', stages: [stage('播报', 2780, 320, 'interrupted')] },
      ],
      marks: [{ atMs: 1240, label: '首字 1.24 s（模型后 0.86 s）' }, { atMs: 3100, label: '打断 │ ptt' }],
      selected: { row: 'model', index: 0 },
    },
  },
  {
    name: 'failed',
    props: { label: '运行瀑布', totalMs: 3 * MIN, terminal: 'failed', emph: 'g1', rows: [{ id: 'g1', label: '第 1 次', stages: [stage('准备', 0, 15_000, 'done'), stage('执行', 15_000, 165_000, 'failed')] }] },
  },
  {
    name: 'run-ok',
    props: {
      label: '运行瀑布',
      totalMs: 9 * MIN,
      terminal: 'ok',
      rows: [
        { id: 'g1', label: '第 1 次', terminal: 'failed', stages: [stage('准备', 0, 20_000, 'done'), stage('执行', 20_000, 100_000, 'failed')] },
        { id: 'g2', label: '第 2 次', stages: [stage('准备', 150_000, 15_000, 'done'), stage('执行', 165_000, 300_000, 'done'), stage('验证', 465_000, 60_000, 'done')] },
      ],
      ticks: [
        { row: 'g2', atMs: 170_000, durationMs: 41_000, label: 'Bash │ npm test', highlight: true },
        { row: 'g2', atMs: 260_000, durationMs: 6_000, label: 'Write │ report.md' },
      ],
    },
  },
  {
    name: 'current',
    props: { label: '运行瀑布', totalMs: 6 * MIN, table: false, rows: [{ id: 'g1', label: '第 1 次', terminal: 'failed', stages: [stage('准备', 0, 30_000, 'done'), stage('执行', 30_000, 60_000, 'failed')] }, { id: 'g2', label: '第 2 次', stages: [stage('准备', 100_000, 30_000, 'done'), stage('执行', 130_000, 230_000, 'current')] }] },
  },
  {
    name: 'table',
    props: { label: '轮次瀑布', totalMs: 900, table: true, rows: [{ id: 'obs', label: '观察摘要', stages: [stage('接收观察', 0, 40, 'done'), stage('模型调用', 40, 860, 'failed')] }] },
  },
];
