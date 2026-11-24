import type { MouseEvent } from 'react';
import { ChartBox, Hatch, SvgRuler, useChart, useSvgId, type ChartCommonProps } from './ChartBox';
import { at, NOW, SAYS, SHOTS } from './v3demo';
import { clampN, cx, EMPH, hm, INK, ticks } from './v3';
import s from './ChartBox.module.css';

export interface StepEvent {
  t: number;
  /** 增量，默认 1 */
  n?: number;
  /** blocked 画 ✕，不计入累计 */
  kind?: 'ok' | 'blocked';
}

/** 累计阶梯线：上限虚线并标数值，预留画斜纹段，已拦截画墨色 ✕；接近上限写黄块；emph 时折线用 trace。 */
export interface CumulativeStepProps extends ChartCommonProps {
  events: StepEvent[];
  t0: number;
  t1: number;
  limit?: number;
  /** 预留数，画在当前值上方 */
  reserve?: number;
  /** 高，默认 120 */
  h?: number;
  w?: number;
  /** 单位，默认「次」 */
  unit?: string;
  now?: number;
  emph?: boolean;
}

export function CumulativeStep({ events, t0, t1, now, limit, reserve = 0, h = 120, w, label = '累计', unit = '次', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: CumulativeStepProps) {
  const c = useChart(w);
  const uid = useSvgId();
  if (!events.length && st === 'ok') st = 'empty';
  const ok = events.filter((e) => e.kind !== 'blocked').sort((a, b) => a.t - b.t);
  const blocked = events.filter((e) => e.kind === 'blocked');
  const tEnd = clampN(now ?? Math.max(t0, ...events.map((e) => e.t)), t0, t1);
  let cum = 0;
  const steps: Array<[number, number]> = [[t0, 0]];
  const cumAt: Array<[number, number]> = [];
  // Running total after each event, so events at one time read 1, 2, … rather than the total at that time.
  const after = new Map<StepEvent, number>();
  for (const e of ok) {
    steps.push([e.t, cum]);
    cum += e.n ?? 1;
    steps.push([e.t, cum]);
    cumAt.push([e.t, cum]);
    after.set(e, cum);
  }
  steps.push([tEnd, cum]);
  const valAt = (t: number) => cumAt.reduce((v, [tt, cc]) => (tt <= t ? cc : v), 0);
  const hi = Math.max(limit ?? 0, cum + reserve, 1) * 1.1;
  const W = c.W;
  const narrow = W < 260;
  const L = narrow ? 6 : 34;
  const R = narrow ? 34 : 58;
  const T = 8;
  const PW = Math.max(10, W - L - R);
  const PH = Math.max(10, h - T - 20);
  const X = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * PW;
  const Y = (v: number) => T + (1 - v / hi) * PH;
  const d = steps.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
  const pct = limit ? (cum + reserve) / limit : 0;
  const lvl = pct >= 0.9 ? 'over' : pct >= 0.7 ? 'hi' : null;
  const lc = emph ? EMPH : INK[0];
  const of = limit != null ? ` / ${limit}` : '';
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + (clampN(((e.clientX - r.left) * W) / (r.width || W) - L, 0, PW) / PW) * (t1 - t0);
    const near = events.reduce<StepEvent | null>((b, ev) => (!b || Math.abs(ev.t - t) < Math.abs(b.t - t) ? ev : b), null);
    if (!near || Math.abs(X(near.t) - X(t)) > 12) c.show(e, `${hm(t)}\n累计 ${valAt(t)} ${unit}${of}`);
    else c.show(e, `${hm(near.t)}\n${near.kind === 'blocked' ? '✕ 已拦截，不计入' : `+${near.n ?? 1} │ 累计 ${after.get(near)} ${unit}${of}`}`);
  };
  const aria = `${label}：已用 ${cum} ${unit}${limit != null ? `，上限 ${limit}` : ''}${reserve ? `，预留 ${reserve}` : ''}${blocked.length ? `，已拦截 ${blocked.length} 次` : ''}`;
  const foot = (
    <div className={s.lg}>
      <span>
        <span className={cx(s.num, s.big)}>{cum}</span>
        {limit != null && <small className={s.num}>/{limit}</small>} {unit}
        {lvl && <span className={lvl === 'over' ? s.dan : s.att}> {lvl === 'over' ? '■ 接近上限' : '▲ 偏高'}</span>}
      </span>
      {reserve > 0 && (
        <span>
          <i className={s.hatch} />
          预留 <span className={s.num}>{reserve}</span>
        </span>
      )}
      {blocked.length > 0 && (
        <span>
          <b className={s.x}>✕</b>已拦截 <span className={s.num}>{blocked.length}</span>
        </span>
      )}
    </div>
  );
  const table = { cols: ['时间', '事件', '累计'], rows: [...events].sort((a, b) => a.t - b.t).map((e) => [hm(e.t), e.kind === 'blocked' ? '已拦截' : `+${e.n ?? 1}`, e.kind === 'blocked' ? '—' : String(after.get(e))]) };
  return (
    <ChartBox name="CumulativeStep" c={c} w={w} h={h} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} foot={foot} table={table} frame={frame}>
      <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={aria} onMouseMove={move}>
        <Hatch id={uid} />
        {ticks(0, hi / 1.1, PH < 50 ? 2 : 3).map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={L + PW} y1={Y(v)} y2={Y(v)} className={s.grid} />
            {!narrow && (
              <text x={L - 6} y={Y(v) + 4} textAnchor="end">
                {v}
              </text>
            )}
          </g>
        ))}
        <line x1={L} x2={L + PW} y1={T + PH} y2={T + PH} className={s.ax} />
        <SvgRuler t0={t0} t1={t1} X={X} y={T + PH} PW={PW} />
        {limit != null && (
          <g data-limit="">
            <line x1={L} x2={L + PW} y1={Y(limit)} y2={Y(limit)} className={s.lim} />
            <text x={L + PW + 6} y={Y(limit) + 4} className={cx(s.zh, s.limT)}>
              {narrow ? limit : `上限 ${limit}`}
            </text>
          </g>
        )}
        <path d={`${d}L${X(tEnd).toFixed(1)} ${Y(0)}L${X(t0)} ${Y(0)}Z`} fill={lc} opacity=".08" />
        <path d={d} fill="none" stroke={lc} strokeWidth="2" strokeLinejoin="miter" strokeLinecap="square" />
        {reserve > 0 && <rect x={X(tEnd) - 3} width="6" y={Y(cum + reserve)} height={Math.max(1, Y(cum) - Y(cum + reserve))} fill={`url(#${uid})`} stroke={lc} strokeWidth=".75" />}
        <circle cx={X(tEnd)} cy={Y(cum)} r="3" fill={lc} />
        <text x={X(tEnd) + 8} y={Y(cum + reserve) + 4} className={cx(s.end, s.key)}>
          {cum}
          {reserve ? `+${reserve}` : ''}
        </text>
        {blocked.map((b, i) => {
          const x = X(b.t);
          const y = Y(valAt(b.t));
          return <path key={`b${i}`} d={`M${x - 3} ${y - 3}L${x + 3} ${y + 3}M${x + 3} ${y - 3}L${x - 3} ${y + 3}`} className={s.xm} data-blocked="" />;
        })}
        {now != null && now >= t0 && now <= t1 && <line x1={X(now)} x2={X(now)} y1={T} y2={T + PH} className={s.now} />}
      </svg>
    </ChartBox>
  );
}

export const CumulativeStepDemos: Array<{ name: string; props: CumulativeStepProps }> = [
  { name: 'shots', props: { label: '今日截图', unit: '张', events: SHOTS, t0: at(8, 0), t1: at(22, 0), now: NOW, limit: 200, reserve: 1, h: 96 } },
  { name: 'emph', props: { label: '今日主动发言', unit: '次', emph: true, events: SAYS, t0: at(8, 0), t1: at(22, 0), now: NOW, limit: 12, h: 96 } },
  { name: 'error', props: { label: '出错态', st: 'error', events: SAYS, t0: at(8, 0), t1: at(22, 0), now: NOW, limit: 12, h: 52 } },
  { name: 'empty', props: { label: '今日截图', unit: '张', empty: '今天还没有截图', events: [], t0: at(8, 0), t1: at(22, 0), now: NOW, limit: 200 } },
];
