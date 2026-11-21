import { useState } from 'react';
import { ChartBox, useChart, type ChartCommonProps } from './ChartBox';
import { NowFlag, TrackRuler } from './Track';
import { at, NOW } from './v3demo';
import { clampN, cx, dur, EMPH, hm, INK, seriesColors } from './v3';
import s from './ChartBox.module.css';
import t from './Track.module.css';
import g from './Gantt.module.css';

export type GanttMarkKind = 'gate-ok' | 'gate-fail' | 'block' | 'diamond';

export interface GanttRow {
  id: string;
  label: string;
  sub?: string;
  /** t1 为 null 表示进行中：画到 now，斜纹 */
  segs: Array<{ t0: number; t1: number | null; state: string; label?: string }>;
  marks?: Array<{ t: number; kind: GanttMarkKind; label?: string }>;
}

/** 甘特（轨道视觉）：顶部刻度尺、当前时刻 trace 小旗、细条用墨色阶；失败和待处理的记号是黄块墨字；maxRows 之外的行收成「另有 N 个」；emph 是行 id 或 state。 */
export interface GanttProps extends ChartCommonProps {
  rows: GanttRow[];
  t0: number;
  t1: number;
  now?: number;
  states: Record<string, { color?: string; label: string }>;
  onPick?: (id: string) => void;
  sel?: string | null;
  /** 名称列宽，默认 148 */
  labelW?: number;
  rowH?: number;
  maxRows?: number;
  emph?: string;
}

/** Glyph, look and text of a mark: `look` (a failure or a wait) is ink on a yellow block, `ink` a plain mark, `dim` a passed gate. */
const MK: Record<GanttMarkKind, [string, 'look' | 'ink' | 'dim', string]> = {
  'gate-ok': ['◆', 'dim', '门禁通过'],
  'gate-fail': ['✕', 'look', '门禁失败'],
  block: ['✕', 'ink', '已拦截'],
  diamond: ['◆', 'look', '待处理'],
};

export function Gantt({ rows, t0, t1, now, states, onPick, sel, labelW = 148, rowH, maxRows, label = '甘特', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: GanttProps) {
  const c = useChart();
  const [more, setMore] = useState(false);
  const rh = rowH ?? (rows.some((r) => r.sub) ? 30 : 22);
  if (!rows.length && st === 'ok') st = 'empty';
  const lw = Math.min(labelW, Math.round(c.W * 0.34));
  const TW = Math.max(10, c.W - lw);
  const P = (x: number) => clampN((x - t0) / (t1 - t0 || 1), 0, 1) * 100;
  const sk = Object.keys(states);
  const scol = seriesColors(
    sk.map((k) => ({ id: k, color: states[k]?.color })),
    emph,
    true,
    emph != null && (sk.includes(emph) || rows.some((r) => r.id === emph)),
  );
  const colOf = (st0: string) => scol[sk.indexOf(st0)] ?? INK[0];
  const counts = sk.map((k) => rows.reduce((n, r) => n + r.segs.filter((x) => x.state === k).length, 0));
  const shown = maxRows && !more && rows.length > maxRows ? rows.slice(0, maxRows) : rows;
  const hidden = rows.length - shown.length;
  const end = (x: { t1: number | null }) => x.t1 ?? now ?? t1;
  const stLabel = (k: string) => states[k]?.label ?? k;
  const aria = `${label}：${rows.map((r) => `${r.label} ${r.segs.map((x) => stLabel(x.state)).join('、')}`).join('；')}`;
  // A passed gate is the harness's own business: no legend entry for it.
  const used = (Object.keys(MK) as GanttMarkKind[]).filter((k) => k !== 'gate-ok' && rows.some((r) => (r.marks ?? []).some((m) => m.kind === k)));
  const foot = (
    <div className={s.lg}>
      {sk.map((k, i) => (
        <span key={k} className={k === emph ? s.em : undefined}>
          <i style={{ background: scol[i] }} />
          {stLabel(k)} <span className={s.num}>{counts[i]}</span>
        </span>
      ))}
      {used.map((k) => (
        <span key={k}>
          <b className={g[MK[k][1]]}>{MK[k][0]}</b> {MK[k][2]}
        </span>
      ))}
    </div>
  );
  const table = { cols: ['行', '状态', '开始', '结束', '时长'], rows: rows.flatMap((r) => r.segs.map((x) => [r.label, stLabel(x.state), hm(x.t0), x.t1 == null ? '现在' : hm(x.t1), dur(end(x) - x.t0)])) };
  return (
    <ChartBox name="Gantt" c={c} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} foot={foot} h={shown.length * rh + 24} table={table} frame={frame}>
      <div className={cx(t.trk, g.gantt)} role={onPick ? 'group' : 'img'} aria-label={aria} style={{ ['--lw' as string]: `${lw}px`, ['--rh' as string]: `${rh}px` }}>
        <div className={cx(t.row, t.ax)}>
          <span />
          <TrackRuler v0={t0} v1={t1} px={TW} now={now} />
        </div>
        {shown.map((r) => {
          const rem = r.id === emph;
          const name = (
            <>
              <span className={g.t}>{r.label}</span>
              {r.sub && <span className={g.s}>{r.sub}</span>}
            </>
          );
          return (
            <div key={r.id} className={cx(t.row, g.row, sel === r.id && g.on, rem && g.em)} data-row={r.id} onClick={onPick ? () => onPick(r.id) : undefined}>
              {onPick ? (
                <button type="button" className={g.name} aria-pressed={sel === r.id}>
                  {name}
                </button>
              ) : (
                <span className={g.name}>{name}</span>
              )}
              <span className={g.track}>
                {r.segs.map((x, i) => (
                  <i
                    key={i}
                    className={cx(g.seg, x.t1 == null && g.live)}
                    style={{ left: `${P(x.t0)}%`, width: `max(2px, ${P(end(x)) - P(x.t0)}%)`, background: rem || (sel === r.id && x.t1 == null) ? EMPH : colOf(x.state) }}
                    onMouseMove={(e) => c.show(e, `${x.label ? `${x.label}\n` : ''}${stLabel(x.state)}\n${hm(x.t0)}–${x.t1 == null ? '现在' : hm(x.t1)} │ ${dur(end(x) - x.t0)}`)}
                  />
                ))}
                {(r.marks ?? []).map((m, i) => {
                  const k = MK[m.kind] ?? MK.diamond;
                  return (
                    <b key={`m${i}`} className={cx(g.mk, g[k[1]])} style={{ left: `${P(m.t)}%` }} aria-hidden="true" onMouseMove={(e) => c.show(e, `${k[2]}${m.label ? `\n${m.label}` : ''}\n${hm(m.t)}`)}>
                      {k[0]}
                    </b>
                  );
                })}
              </span>
            </div>
          );
        })}
        {hidden > 0 && (
          <div className={cx(t.row, g.more)}>
            <span />
            <button type="button" className={s.lnk} onClick={() => setMore(true)} data-more="">
              另有 <span className={s.num}>{hidden}</span> 个
            </button>
          </div>
        )}
        {more && maxRows && rows.length > maxRows && (
          <div className={cx(t.row, g.more)}>
            <span />
            <button type="button" className={s.lnk} onClick={() => setMore(false)}>
              收起
            </button>
          </div>
        )}
        {now != null && now >= t0 && now <= t1 && <NowFlag f={P(now) / 100} at={now} />}
      </div>
    </ChartBox>
  );
}

export const GANTT_ROWS: GanttRow[] = [
  {
    id: 'g1',
    label: 'Endfield / claude',
    sub: '重构 HostLink',
    segs: [
      { t0: at(9, 10), t1: at(10, 5), state: 'run' },
      { t0: at(10, 5), t1: at(10, 12), state: 'wait' },
      { t0: at(10, 12), t1: at(11, 40), state: 'run' },
      { t0: at(13, 0), t1: at(14, 10), state: 'run' },
      { t0: at(14, 10), t1: null, state: 'wait', label: '待批准 rm -rf build/' },
    ],
    marks: [{ t: at(13, 32), kind: 'block', label: 'git push --force 已拦截' }],
  },
  {
    id: 'g2',
    label: 'Endfield / codex',
    sub: '修测试',
    segs: [
      { t0: at(10, 30), t1: at(12, 10), state: 'run' },
      { t0: at(12, 10), t1: at(12, 20), state: 'fail' },
      { t0: at(12, 20), t1: at(13, 5), state: 'run' },
    ],
    marks: [{ t: at(12, 12), kind: 'gate-fail', label: '检查 37/43' }],
  },
  { id: 'g3', label: '角色 │ 整理周报', sub: '第 3/5 步', segs: [{ t0: at(14, 2), t1: null, state: 'run' }], marks: [{ t: at(14, 20), kind: 'diamond', label: '问：按项目还是按日期？' }] },
  { id: 'g4', label: 'Endfield / claude', sub: '文档校对', segs: [{ t0: at(9, 40), t1: at(10, 0), state: 'run' }] },
];
export const GANTT_STATES = { run: { label: '执行' }, wait: { color: 'var(--ef-attention)', label: '待处理' }, fail: { color: 'var(--ef-ink-s2)', label: '出错' } };

export const GanttDemos: Array<{ name: string; props: GanttProps }> = [
  { name: 'day', props: { label: '今日编码会话甘特', rows: GANTT_ROWS, t0: at(9, 0), t1: at(15, 0), now: NOW, states: GANTT_STATES, sel: 'g1', onPick: () => undefined, maxRows: 3 } },
  { name: 'emph', props: { label: '今日编码会话甘特', rows: GANTT_ROWS.slice(0, 2), t0: at(9, 0), t1: at(15, 0), now: NOW, states: GANTT_STATES, emph: 'g2' } },
  { name: 'empty', props: { label: '今日编码会话甘特', empty: '今天还没有编码会话', rows: [], t0: at(9, 0), t1: at(15, 0), states: GANTT_STATES } },
];
