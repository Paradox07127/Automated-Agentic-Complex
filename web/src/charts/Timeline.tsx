import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ChartBox, useChart, type ChartCommonProps } from './ChartBox';
import { NowFlag, TrackRuler } from './Track';
import { itemTip, LANE_H, LaneItems, type Cluster, type LaneCtx, type TimelineItem, type TimelineLaneSpec } from './TimelineLane';
import { TimelineMinimap } from './TimelineMinimap';
import { at, EPISODES, NOW, SHOT_TIMES, STRIP } from './v3demo';
import { clampN, cx, hm, hms } from './v3';
import s from './ChartBox.module.css';
import t from './Track.module.css';
import l from './Timeline.module.css';

export type { TimelineItem, TimelineKind, TimelineLaneSpec } from './TimelineLane';

/** Narrowest zoom window: one minute. */
export const MIN_SPAN = 60e3;

/** 多泳道轨道：刻度尺、当前时刻小旗、细轨；事件点过密合并成计数签；悬停十字线加读数卡；zoom 时滚轮缩放、拖动平移、双击复位，底部全日缩略带。 */
export interface TimelineProps extends ChartCommonProps {
  lanes: TimelineLaneSpec[];
  t0: number;
  t1: number;
  now?: number;
  /** 滚轮缩放（最细 1 分钟）、拖动平移、双击复位 */
  zoom?: boolean;
  onPick?: (item: TimelineItem, lane: TimelineLaneSpec) => void;
  /** 选中的 item.id */
  sel?: string | null;
  /** 名称列宽，默认 64 */
  labelW?: number;
  /** item id 或泳道 id */
  emph?: string;
  /** 自定义读数卡内容 */
  renderTip?: (item: TimelineItem, lane: TimelineLaneSpec) => ReactNode;
  /** 全日缩略带，默认跟 zoom 一致 */
  minimap?: boolean;
  /** 暂停或无数据：斜纹加文字 */
  pauses?: Array<{ t0: number; t1: number; label?: string }>;
  /** 刻度尺上的 ▼：done 画灰（已过），emph 用强调色 */
  axisMarks?: Array<{ t: number; label: string; kind?: 'done' | 'emph' }>;
}

interface Hover {
  it: TimelineItem;
  lane: TimelineLaneSpec;
  ax?: boolean;
}

export function Timeline({ lanes, t0, t1, now, zoom, onPick, sel, labelW = 64, label = '时间轴', st = 'ok', empty, stoppedAt, onRetry, emph, renderTip, minimap, pauses = [], axisMarks = [], frame }: TimelineProps) {
  const c = useChart();
  const [view, setView] = useState<[number, number]>([t0, t1]);
  const [hov, setHov] = useState<{ f: number; t: number } | null>(null);
  useEffect(() => setView([t0, t1]), [t0, t1]);
  // State, not a ref: the table view and ChartState remount the track, and the wheel listener must follow it.
  const [trk, setTrk] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; v: [number, number]; w: number; moved: boolean } | null>(null);
  const hovIt = useRef<Hover | null>(null);
  if (!lanes.some((x) => x.items.length) && st === 'ok') st = 'empty';
  const [v0, v1] = view;
  const span = v1 - v0 || 1;
  const full = t1 - t0;
  const P = (x: number) => ((x - v0) / span) * 100;
  const lw = c.W < 420 ? Math.min(labelW, 36) : labelW;
  const TW = Math.max(10, c.W - lw);
  const PX = (x: number) => ((x - v0) / span) * TW;
  const mmOn = minimap ?? !!zoom;
  const setWindow = (a: number, sp: number) => {
    const ns = clampN(sp, MIN_SPAN, full);
    const na = clampN(a, t0, t1 - ns);
    setView([na, na + ns]);
  };
  useEffect(() => {
    const el = trk;
    if (!zoom || !el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = clampN((e.clientX - r.left - lw) / (r.width - lw || 1), 0, 1);
      setView(([a, b]) => {
        const sp = b - a;
        const ns = clampN(sp * Math.exp(e.deltaY * 0.0015), MIN_SPAN, t1 - t0);
        const na = clampN(a + f * sp - f * ns, t0, t1 - ns);
        return [na, na + ns];
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoom, t0, t1, lw, trk]);
  const tAt = (e: MouseEvent) => {
    const r = trk?.getBoundingClientRect();
    if (!r) return null;
    const f = (e.clientX - r.left - lw) / (r.width - lw || 1);
    return f < 0 || f > 1 ? null : { f, t: v0 + f * span };
  };
  const fmtT = span <= 20 * 60e3 ? hms : hm;
  const card = (x: number) => {
    const h = hovIt.current;
    return (
      <div className={l.rd}>
        <b>{fmtT(x)}</b>
        {h ? renderTip && !h.ax ? renderTip(h.it, h.lane) : <span>{itemTip(h.it, h.lane)}</span> : null}
      </div>
    );
  };
  const down = (e: MouseEvent) => {
    if (!zoom) return;
    drag.current = { x: e.clientX, v: view, w: (trk?.getBoundingClientRect().width ?? lw + 1) - lw, moved: false };
  };
  const move = (e: MouseEvent) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        const sp = d.v[1] - d.v[0];
        setWindow(d.v[0] - (dx / (d.w || 1)) * sp, sp);
        c.hide();
        setHov(null);
        return;
      }
    }
    const p = tAt(e);
    if (!p) {
      setHov(null);
      c.hide();
      return;
    }
    setHov(p);
    c.show(e, card(p.t));
  };
  const up = () => setTimeout(() => (drag.current = null), 0);
  const leave = () => {
    drag.current = null;
    hovIt.current = null;
    setHov(null);
    c.hide();
  };
  const ctx: LaneCtx = {
    v0,
    v1,
    P,
    PX,
    TW,
    sel,
    emph,
    zoom,
    enter: (it, lane) => (hovIt.current = { it, lane }),
    leave: () => (hovIt.current = null),
    pick: (it, lane) => (e) => {
      if (drag.current?.moved) return;
      e.stopPropagation();
      onPick?.(it, lane);
    },
    zoomTo: (g: Cluster) => {
      const a = g.items[0]?.t ?? v0;
      const b = g.items[g.items.length - 1]?.t ?? v1;
      const pad = Math.max(MIN_SPAN, (b - a) * 0.3);
      setWindow(a - pad, b - a + 2 * pad);
    },
  };
  const zoomed = span < full - 1000;
  const aria = `${label}：${lanes.map((x) => `${x.label} ${x.items.length} 项`).join('，')}${zoom ? '。滚轮缩放，拖动平移，双击复位' : ''}`;
  const table = { cols: ['泳道', '开始', '结束', '内容'], rows: lanes.flatMap((x) => x.items.map((it) => [x.label, hm(it.t0 ?? it.t ?? 0), it.t1 != null ? hm(it.t1) : '—', it.label ?? (it.kind === 'fail' ? '失败' : '')])) };
  const foot = zoom && (
    <div className={s.lg}>
      <span className={s.num}>
        {fmtT(v0)}–{fmtT(v1)}
      </span>
      <span className={s.t3}>滚轮缩放 │ 拖动平移 │ 双击复位</span>
      {zoomed && (
        <button type="button" className={s.lnk} onClick={() => setView([t0, t1])}>
          复位
        </button>
      )}
    </div>
  );
  const col = (x: number) => `calc(var(--lw) + (100% - var(--lw)) * ${x})`;
  const axm = axisMarks
    .filter((m) => m.t >= v0 && m.t <= v1)
    .map((m, i) => <span key={`ax${i}`} className={cx(l.axm, m.kind === 'done' && l.done, m.kind === 'emph' && l.emph)} style={{ left: `${P(m.t)}%` }} role="img" aria-label={`${m.label} ${hm(m.t)}`} onMouseEnter={() => (hovIt.current = { it: { t: m.t, tip: `${m.label}\n${hm(m.t)}` }, lane: { id: '', label: '', kind: 'markers', items: [] }, ax: true })} onMouseLeave={ctx.leave} />);
  return (
    <ChartBox name="Timeline" c={c} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} foot={foot} h={lanes.length * 22 + 24} table={table} frame={frame}>
      <div className={t.trk} role="group" aria-label={aria} style={{ ['--lw' as string]: `${lw}px` }}>
        <div className={l.body} ref={setTrk}data-v0={v0} data-v1={v1} onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={leave} onDoubleClick={() => zoom && setView([t0, t1])}>
          <div className={cx(t.row, t.ax)}>
            <span />
            <TrackRuler v0={v0} v1={v1} px={TW} now={now} marks={axm} />
          </div>
          {lanes.map((x) => (
            <div key={x.id} className={cx(t.row, l.lane)} data-kind={x.kind} style={{ ['--th' as string]: `${LANE_H[x.kind] ?? 16}px` }}>
              <span className={l.ll}>{x.label}</span>
              <span className={l.lt}>
                <LaneItems lane={x} ctx={ctx} />
              </span>
            </div>
          ))}
          {pauses
            .filter((p) => p.t1 >= v0 && p.t0 <= v1)
            .map((p, i) => {
              const a = clampN(P(p.t0), 0, 100);
              const b = clampN(P(p.t1), 0, 100);
              return (
                <span key={`pz${i}`} className={l.pz} style={{ left: col(a / 100), width: `calc((100% - var(--lw)) * ${(b - a) / 100})` }} role="img" aria-label={`${p.label ?? '暂停'} ${hm(p.t0)}–${hm(p.t1)}`}>
                  {p.label && <b>{p.label}</b>}
                </span>
              );
            })}
          {now != null && now >= v0 && now <= v1 && <NowFlag f={P(now) / 100} at={now} />}
          {hov && !drag.current && <span className={l.hair} style={{ left: col(hov.f) }} aria-hidden="true" />}
        </div>
        {mmOn && <TimelineMinimap t0={t0} t1={t1} view={view} min={MIN_SPAN} lanes={lanes} pauses={pauses} now={now} setWindow={setWindow} setView={setView} />}
      </div>
    </ChartBox>
  );
}

const ticksAt = [at(9, 20), at(10, 5), at(10, 7), at(11, 50), at(13, 15), at(14, 22), at(14, 29)];
export const TIMELINE_LANES: TimelineLaneSpec[] = [
  { id: 'ep', label: '片段', kind: 'spans', items: EPISODES },
  { id: 'app', label: '应用', kind: 'strip', items: STRIP },
  { id: 'chat', label: '对话', kind: 'ticks', items: ticksAt.map((x, i) => ({ id: `c${i}`, t: x, tip: `对话 │ ${hm(x)}` })) },
  { id: 'say', label: '发言', kind: 'markers', items: [{ id: 's1', t: at(9, 30), label: '喝水' }, { id: 's2', t: at(11, 48), label: '会开完了？' }, { id: 's3', t: at(14, 25) }] },
  { id: 'shot', label: '截图', kind: 'dots', items: [...SHOT_TIMES.map((x, i) => ({ id: `p${i}`, t: x, tip: `截图 │ ${hms(x)}` })), { id: 'pf1', t: at(10, 21), kind: 'fail' as const, tip: '截图已拦截 │ 10:21' }] },
];
const LANES3: TimelineLaneSpec[] = [
  { id: 'doing', label: '用户活动', kind: 'blocks', items: EPISODES },
  { id: 'run', label: '对话与任务', kind: 'blocks', items: [{ id: 'k1', t0: at(9, 10), t1: at(11, 40), label: '重构 HostLink' }, { id: 'k2', t0: at(12, 20), t1: at(13, 5), label: '修测试' }, { id: 'k3', t0: at(14, 2), t1: at(14, 32), label: '整理周报' }] },
  { id: 'say', label: '主动发言', kind: 'markers', items: [{ id: 's1', t: at(9, 30), label: '喝水' }, { id: 's2', t: at(11, 48), label: '会开完了？' }, { id: 's3', t: at(14, 25) }] },
];

export const TimelineDemos: Array<{ name: string; props: TimelineProps }> = [
  { name: 'observe', props: { label: '今日时间线', lanes: TIMELINE_LANES, t0: at(9, 0), t1: at(15, 30), now: NOW, zoom: true, pauses: [{ t0: at(12, 5), t1: at(12, 40), label: '观察暂停' }], sel: 'e3', onPick: () => undefined, labelW: 48 } },
  { name: 'brief', props: { label: '今日简报', lanes: LANES3, t0: at(9, 0), t1: at(16, 0), now: NOW, emph: 'k3', labelW: 80, axisMarks: [{ t: at(10, 0), label: '提醒 │ 站会', kind: 'done' }, { t: at(15, 0), label: '提醒 │ 周会', kind: 'emph' }] } },
  { name: 'empty', props: { label: '今日时间线', empty: '今天还没有活动', lanes: [{ id: 'ep', label: '片段', kind: 'spans', items: [] }], t0: at(9, 0), t1: at(15, 0) } },
];
