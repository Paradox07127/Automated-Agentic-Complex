import { useEffect, useState } from 'react';
import { formatClock, formatDuration, stateVisual, type VisualStateKey, type VisualTone } from '../domain';
import { useChartLabel } from './ChartLabel';
import { ChartLegend, type LegendItem } from './ChartLegend';
import { DataTable, TableToggle } from './ChartTable';
import { clockTickLabel, fraction, timeStep, timeTicks } from './scale';
import { SHAPE_CHAR, ShapeGlyph, StateMark } from './StateMark';
import common from './chart.module.css';
import palette from './palette.module.css';
import styles from './Swimlane.module.css';

export interface SwimlaneBar {
  id: string;
  start: number;
  /** Null = still running; ends at the "now" cursor with a hatch. */
  end: number | null;
  state: VisualStateKey;
  label?: string;
  /** 斜纹段：同一泳道里的次要状态（例如「离开」），不是「未结束」 */
  hatched?: boolean;
  /** 门禁失败：条尾画 ▼ */
  gateFailed?: boolean;
}

export interface SwimlaneLane {
  id: string;
  label: string;
  /** Category of the lane; told apart by its label and position, not colour (bars take their state colour). */
  kind: 'mission' | 'neutral' | 'attention' | 'done' | 's1';
  narrow?: boolean;
  bars: SwimlaneBar[];
  /** 这条泳道读失败：名后黄块 ✕，轨道里写「读取失败」和原因，其他泳道照常 */
  error?: string;
}

/** 泳道时间线：泳道高 14（窄带 8），条按状态着色，进行中条斜纹接「现在」线，只标注最长 1 段；图例在图下带计数；带表格视图。 */
export interface SwimlaneProps {
  /** 泳道 */
  lanes: SwimlaneLane[];
  /** 时间轴起点（epoch ms） */
  start: number;
  /** 时间轴终点（epoch ms） */
  end: number;
  /** 读屏名称 */
  label: string;
  /** 「现在」光柱位置；不给不画 */
  now?: number;
  /** 截断或口径说明，例如「只显示最近 50 次」 */
  note?: string;
  /** 以表格查看 */
  table?: boolean;
  /** 选中条（受控）；不给时由点击自己记 */
  selected?: { lane: string; bar: string } | null;
  /** 点条 */
  onPick?: (laneId: string, barId: string) => void;
  /** 要强调的条 id 或泳道 id：用强调色，其余墨色灰阶 */
  emph?: string;
}

export interface SwimlaneRow {
  lane: string;
  laneLabel: string;
  bar: SwimlaneBar;
  /** Drawn end: the bar's end, or "now" while running. */
  until: number;
  durationMs: number;
}

/** Every bar as drawn, in lane order; open bars end at `now` (or the axis end). */
export function swimlaneRows(lanes: ReadonlyArray<SwimlaneLane>, now: number): SwimlaneRow[] {
  return lanes.flatMap((l) =>
    l.bars.map((b) => {
      const until = b.end ?? Math.max(b.start, now);
      return { lane: l.id, laneLabel: l.label, bar: b, until, durationMs: Math.max(0, until - b.start) };
    }),
  );
}

/** Legend order. */
const TONES: VisualTone[] = ['running', 'waiting', 'failed', 'warning', 'ok', 'cancelled', 'idle'];
const toneOf = (r: SwimlaneRow): VisualTone => stateVisual(r.bar.state).tone;

function legendMark(tone: VisualTone) {
  const v = stateVisual(tone === 'ok' ? 'done' : tone);
  // 已完成 bars are chart-done grey, not the green check colour.
  return <ShapeGlyph shape={v.shape} token={tone === 'ok' ? '--ef-chart-done' : tone === 'running' ? '--v3-ink-1' : v.token} size={8} />;
}

/**
 * Legend items per lane, so one lane's bars never count toward another's: a lane whose solid bars share one state is
 * one item named after the lane, else one item per state; hatched bars count under their own label. Then gate failures.
 */
export function swimlaneLegend(lanes: ReadonlyArray<SwimlaneLane>, rows: ReadonlyArray<SwimlaneRow>): LegendItem[] {
  const items: LegendItem[] = lanes.flatMap((l) => {
    const mine = rows.filter((r) => r.lane === l.id);
    const solid = mine.filter((r) => !r.bar.hatched);
    const tones = TONES.filter((tone) => solid.some((r) => toneOf(r) === tone));
    const byState = tones.map((tone) => ({
      key: `${l.id}:${tone}`,
      label: tones.length === 1 ? l.label : `${l.label} │ ${stateVisual(tone === 'ok' ? 'done' : tone).label}`,
      count: solid.filter((r) => toneOf(r) === tone).length,
      mark: legendMark(tone),
    }));
    const hatched = mine.filter((r) => r.bar.hatched);
    const names = [...new Set(hatched.map((r) => r.bar.label ?? stateVisual(r.bar.state).label))];
    const byLabel = names.map((name) => {
      const same = hatched.filter((r) => (r.bar.label ?? stateVisual(r.bar.state).label) === name);
      return { key: `${l.id}:~${name}`, label: name, count: same.length, mark: legendMark(toneOf(same[0]!)) };
    });
    return [...byState, ...byLabel];
  });
  const gates = rows.filter((r) => r.bar.gateFailed).length;
  if (gates > 0)
    items.push({
      key: 'gate',
      label: '门禁失败',
      count: gates,
      mark: (
        <span className={styles.gateMark} aria-hidden="true">
          ▼
        </span>
      ),
    });
  return items;
}

export function Swimlane({ lanes, start, end, label, now, note, table = false, selected, onPick, emph }: SwimlaneProps) {
  const [tbl, setTbl] = useState(table);
  useEffect(() => setTbl(table), [table]);
  const [own, setOwn] = useState<string | null>(null);
  const sel = selected === undefined ? own : selected && `${selected.lane}:${selected.bar}`;
  const cursor = now ?? end;
  const rows = swimlaneRows(lanes, cursor);
  const X = (t: number) => fraction(t - start, end - start);
  const longest = rows.filter((r) => !lanes.find((l) => l.id === r.lane)?.narrow).reduce<SwimlaneRow | null>((a, r) => (a == null || r.durationMs > a.durationMs ? r : a), null);
  const step = timeStep(end - start);
  const ticks = timeTicks(start, end);
  const legend = swimlaneLegend(lanes, rows);
  const perLane = lanes.map((l) => (l.error ? `${l.label} 读取失败` : `${l.label} ${rows.filter((r) => r.lane === l.id).length} 段`)).join('，');
  const lbl = useChartLabel(label, `${perLane}${longest ? `，最长 ${formatDuration(longest.durationMs)}` : ''}${legend.length ? `，${legend.map((i) => `${i.label} ${i.count}`).join('，')}` : ''}`);
  const pick = (r: SwimlaneRow) => {
    setOwn(`${r.lane}:${r.bar.id}`);
    onPick?.(r.lane, r.bar.id);
  };
  const tipOf = (r: SwimlaneRow) => {
    const v = stateVisual(r.bar.state);
    return `${r.laneLabel}${r.bar.label ? ` │ ${r.bar.label}` : ''}\n${formatClock(r.bar.start)}–${r.bar.end == null ? '现在' : formatClock(r.bar.end)} │ ${formatDuration(r.durationMs)}\n${SHAPE_CHAR[v.shape]} ${r.bar.end == null ? '进行中（未结束）' : v.label}${r.bar.gateFailed ? ' │ ▼ 门禁失败' : ''}`;
  };
  if (rows.length === 0 && !lanes.some((l) => l.error)) {
    return (
      <figure data-stub="Swimlane" data-start={start} data-end={end} data-empty="" className={styles.root}>
        <p className={common.emptyLine}>{label}：这段时间没有记录</p>
      </figure>
    );
  }
  return (
    <figure data-stub="Swimlane" data-start={start} data-end={end} data-now={now} data-table={tbl || undefined} aria-label={label} className={`${palette.palette} ${styles.root}`}>
      <div className={common.head}>
        <span className={common.headText}>
          {label}
          {longest && (
            <>
              {' '}
              │ 最长 <span className={common.num}>{formatDuration(longest.durationMs)}</span>
            </>
          )}
        </span>
        <span className={common.spacer} />
        <TableToggle on={tbl} onToggle={setTbl} />
      </div>
      {tbl ? (
        <DataTable
          caption={label}
          columns={[{ label: '泳道' }, { label: '内容' }, { label: '开始' }, { label: '结束' }, { label: '时长', align: 'right' }, { label: '状态' }]}
          selected={sel}
          onRow={(k) => {
            const r = rows.find((x) => `${x.lane}:${x.bar.id}` === k);
            if (r) pick(r);
          }}
          rows={rows.map((r) => ({
            key: `${r.lane}:${r.bar.id}`,
            cells: [r.laneLabel, r.bar.label ?? r.bar.id, formatClock(r.bar.start), r.bar.end == null ? '现在' : formatClock(r.bar.end), formatDuration(r.durationMs), <StateMark key="s" state={r.bar.end == null ? 'running' : r.bar.state} label={r.bar.end == null ? '进行中' : r.bar.gateFailed ? `${stateVisual(r.bar.state).label} │ ▼ 门禁失败` : undefined} />],
          }))}
        />
      ) : (
        <div className={styles.plot} role="group" aria-label={`${label}，${perLane}`}>
          {lanes.map((l) => (
            <div key={l.id} className={styles.lane} data-kind={l.kind} data-narrow={l.narrow || undefined} data-error={l.error ? '' : undefined}>
              <span className={styles.laneLabel} title={l.error}>
                {l.label}
                {l.error && (
                  <span className={styles.laneErr}>
                    {' '}
                    <ShapeGlyph shape="square" token="--ef-state-failed" size={8} />
                  </span>
                )}
              </span>
              <div className={styles.track}>
                {l.error ? (
                  <span className={styles.errText} role="alert">
                    <ShapeGlyph shape="square" token="--ef-state-failed" size={8} /> 读取失败 │ {l.error}
                  </span>
                ) : (
                  l.bars.length === 0 && <span className={styles.none}>—</span>
                )}
                {rows
                  .filter((r) => r.lane === l.id && !l.error)
                  .map((r) => {
                    const v = stateVisual(r.bar.state);
                    const x0 = X(r.bar.start);
                    const w = Math.max(0, X(r.until) - x0);
                    const isLong = longest === r;
                    const inside = w >= 0.08;
                    return (
                      <button
                        key={r.bar.id}
                        type="button"
                        className={`${styles.bar} ${common.tip}`}
                        data-bar={r.bar.id}
                        data-tone={v.tone}
                        data-open={r.bar.end == null || undefined}
                        data-hatched={r.bar.hatched || undefined}
                        data-gate={r.bar.gateFailed ? 'failed' : undefined}
                        data-start={r.bar.start}
                        data-until={r.until}
                        data-selected={sel === `${r.lane}:${r.bar.id}` || undefined}
                        data-emph={(emph != null && (r.bar.id === emph || r.lane === emph)) || undefined}
                        data-tip={tipOf(r)}
                        aria-label={tipOf(r).replace(/\n/g, '，')}
                        style={{ left: `${x0 * 100}%`, width: `max(2px, calc(${w * 100}% - 2px))` }}
                        onClick={() => pick(r)}
                      >
                        {r.bar.gateFailed && (
                          <span className={styles.gate} aria-hidden="true">
                            ▼
                          </span>
                        )}
                        {isLong && (
                          <span className={inside ? styles.annIn : styles.annOut} aria-hidden="true">
                            {formatDuration(r.durationMs)}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
          {lbl.text}
          <div className={styles.lane} {...lbl.img}>
            <span />
            <div className={styles.axis}>
              {ticks.map((t) => (
                <span key={t} className={styles.tick} style={{ left: `${X(t) * 100}%` }}>
                  {clockTickLabel(t, step)}
                </span>
              ))}
            </div>
          </div>
          {now != null && now >= start && now <= end && <span className={styles.now} style={{ ['--x' as string]: X(now) }} aria-hidden="true" />}
        </div>
      )}
      {!tbl && legend.length > 0 && <ChartLegend items={legend} />}
      {note && <figcaption className={styles.note}>{note}</figcaption>}
    </figure>
  );
}

const t = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime();

export const SwimlaneDemos: Array<{ name: string; props: SwimlaneProps }> = [
  {
    name: 'day',
    props: {
      label: '今日活动',
      start: t(8, 0),
      end: t(15, 0),
      now: t(14, 32),
      note: '只显示最近 50 次',
      lanes: [
        { id: 'runs', label: '运行', kind: 'mission', bars: [{ id: 'run-0f11', start: t(10, 12), end: t(10, 15), state: 'failed', label: '下载资源索引' }, { id: 'run-77a2', start: t(11, 50), end: t(12, 34), state: 'succeeded', label: '整理账单' }, { id: 'run-8d03', start: t(14, 22), end: null, state: 'running', label: '汇总开销' }] },
        { id: 'code', label: '编码', kind: 'neutral', bars: [{ id: 's1', start: t(10, 5), end: t(11, 40), state: 'succeeded', label: 'HostLink 修复' }, { id: 's2', start: t(13, 2), end: t(13, 20), state: 'failed', label: '重构测试', gateFailed: true }] },
        { id: 'apv', label: '审批', kind: 'attention', narrow: true, bars: [{ id: 'd1', start: t(11, 5), end: t(11, 6), state: 'waiting' }, { id: 'd2', start: t(14, 30), end: null, state: 'waiting' }] },
      ],
    },
  },
  {
    name: 'emph',
    props: { label: '在电脑前', start: t(8, 0), end: t(15, 0), now: t(14, 32), emph: 'a1', lanes: [{ id: 'here', label: '在场', kind: 's1', bars: [{ id: 'a0', start: t(9, 0), end: t(11, 30), state: 'done' }, { id: 'a1', start: t(12, 40), end: t(14, 10), state: 'done' }, { id: 'a2', start: t(14, 10), end: null, state: 'running' }] }] },
  },
  {
    name: 'table',
    props: { label: '今日活动', table: true, start: t(8, 0), end: t(15, 0), now: t(14, 32), lanes: [{ id: 'runs', label: '运行', kind: 'mission', bars: [{ id: 'run-0f11', start: t(10, 12), end: t(10, 15), state: 'failed' }, { id: 'run-8d03', start: t(14, 22), end: null, state: 'running' }] }] },
  },
  {
    name: 'hour',
    props: { label: '本轮对话', start: t(14, 0), end: t(14, 35), now: t(14, 32), lanes: [{ id: 'turns', label: '轮次', kind: 's1', bars: [{ id: 'a', start: t(14, 2), end: t(14, 3), state: 'ok' }, { id: 'b', start: t(14, 10), end: t(14, 14), state: 'ok' }, { id: 'c', start: t(14, 24), end: t(14, 25), state: 'failed' }, { id: 'd', start: t(14, 29), end: null, state: 'running' }] }] },
  },
  {
    name: 'presence',
    props: { label: '在电脑前', start: t(8, 0), end: t(15, 0), now: t(14, 32), selected: { lane: 'here', bar: 'a1' }, lanes: [{ id: 'here', label: '在场', kind: 's1', bars: [{ id: 'a0', start: t(9, 0), end: t(11, 30), state: 'done' }, { id: 'x0', start: t(11, 30), end: t(12, 40), state: 'idle', label: '离开', hatched: true }, { id: 'a1', start: t(12, 40), end: null, state: 'running' }] }] },
  },
  {
    name: 'lane-error',
    props: { label: '今日活动', start: t(8, 0), end: t(15, 0), now: t(14, 32), lanes: [{ id: 'runs', label: '运行', kind: 'done', bars: [{ id: 'r1', start: t(10, 0), end: t(10, 40), state: 'succeeded' }] }, { id: 'code', label: '编码', kind: 'neutral', bars: [], error: '/agent/sessions 返回 503' }] },
  },
  {
    name: 'empty-lane',
    props: { label: '今日活动', start: t(8, 0), end: t(15, 0), now: t(14, 32), lanes: [{ id: 'runs', label: '运行', kind: 'mission', bars: [] }, { id: 'code', label: '编码', kind: 'neutral', bars: [{ id: 's1', start: t(9, 0), end: t(9, 2), state: 'cancelled' }] }] },
  },
];
