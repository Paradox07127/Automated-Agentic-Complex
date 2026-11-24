import { useState, type MouseEvent } from 'react';
import { ChartBox, Hatch, useChart, useSvgId, type ChartCommonProps } from './ChartBox';
import { clampN, cx, pad2 } from './v3';
import s from './ChartBox.module.css';
import a from './HourArea.module.css';

export interface HourAreaLine {
  id: string;
  label: string;
  /** [钟点, 值]，按钟点升序 */
  pts: Array<[number, number]>;
  dash?: boolean;
}

/**
 * 一天 24 小时的阶梯面积（照电力图）：0 / 半 / 满三条刻度，每 3 小时一个时刻；有 now 时画竖线和黄底时刻牌，之后的部分斜纹；
 * 可叠暂停区间、提醒 ▼ 和不用左轴的折线；悬停一小时出提示。钟点都是本地时间 0–24，可带小数。
 */
export interface HourAreaProps extends ChartCommonProps {
  /** 0–23 点每小时的值，长 24 */
  hours: number[];
  /** 满刻度；超过的值顶格 */
  max: number;
  /** 左上的单位，如「分钟 / 小时」 */
  unit: string;
  /** 面积在图例里的名字 */
  name: string;
  /** 悬停一小时的读数，如「在电脑前 35 分钟」 */
  tip: (v: number, h: number) => string;
  /** 现在的钟点；不给表示这一天已过完 */
  now?: number;
  /** 暂停区间 [起, 止] */
  pauses?: Array<[number, number]>;
  /** 提醒 ▼ */
  marks?: Array<{ h: number; label: string }>;
  /** 叠加折线，按 lineRange 自己的刻度画 */
  lines?: HourAreaLine[];
  /** 折线的 [下, 上] 端，默认 [0, 1] */
  lineRange?: [number, number];
  /** 高，默认 200 */
  h?: number;
  w?: number;
}

// Whole minutes first: (t % 1) * 60 lands just under the minute for many h + m/60.
const clock = (t: number) => {
  const m = Math.floor(t * 60 + 1e-9);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
};

export function HourArea({ hours, max, unit, name, tip, now, pauses = [], marks = [], lines = [], lineRange = [0, 1], h = 200, w, label = '每小时', st = 'ok', empty, stoppedAt, onRetry, frame }: HourAreaProps) {
  const c = useChart(w);
  const uid = useSvgId();
  const [hv, setHv] = useState<number | null>(null);
  const W = c.W;
  const L = 34;
  const R = 8;
  const T = 18;
  // Under the plot: hour labels and the now plate; the ▼ marks sit on the plot's top edge.
  const YB = h - 42;
  const PW = Math.max(10, W - L - R);
  const X = (t: number) => L + (PW * clampN(t, 0, 24)) / 24;
  const Y = (v: number) => YB - ((YB - T) * clampN(v, 0, max)) / max;
  const [lo, hi] = lineRange;
  const LY = (v: number) => YB - ((YB - T) * (clampN(v, lo, hi) - lo)) / (hi - lo);
  const end = now ?? 24;
  let top = '';
  for (let k = 0; k < 24 && k < end; k++) top += `${k ? 'L' : 'M'}${X(k).toFixed(1)} ${Y(hours[k]!).toFixed(1)}L${X(Math.min(k + 1, end)).toFixed(1)} ${Y(hours[k]!).toFixed(1)}`;
  const last = Math.min(Math.ceil(end), 24) - 1;
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.floor((clampN(((e.clientX - r.left) * W) / (r.width || W) - L, 0, PW - 1) / PW) * 24);
    if (k > last) {
      setHv(null);
      c.hide();
      return;
    }
    setHv(k);
    const near = lines.flatMap((l) => {
      const p = l.pts.filter((q) => q[0] >= k && q[0] < k + 1).reduce<[number, number] | null>((b, q) => (!b || Math.abs(q[0] - k - 0.5) < Math.abs(b[0] - k - 0.5) ? q : b), null);
      return p ? [`${l.label} ${p[1].toFixed(1)}`] : [];
    });
    const rem = marks.filter((m) => m.h >= k && m.h < k + 1).map((m) => `▼ ${m.label}`);
    c.show(e, [`${pad2(k)}:00`, tip(hours[k]!, k), ...near, ...rem].join('\n'));
  };
  const leave = () => setHv(null);
  const total = hours.reduce((x, y) => x + y, 0);
  const aria = `${label}：共 ${total}${total ? `，最多在 ${pad2(hours.indexOf(Math.max(...hours)))}:00` : ''}${pauses.length ? `，暂停 ${pauses.length} 段` : ''}${marks.length ? `，提醒 ${marks.length} 个` : ''}`;
  const foot = (
    <div className={s.lg}>
      <span>
        <i className={a.sw} />
        {name}
      </span>
      {lines.map((l) => (
        <span key={l.id}>
          <i className={cx(s.ln, l.dash ? a.dashSw : a.lineSw)} />
          {l.label}
        </span>
      ))}
      {pauses.length > 0 && (
        <span>
          <i className={s.hatch} />
          暂停
        </span>
      )}
      {marks.length > 0 && (
        <span>
          <b className={a.tri} aria-hidden="true">
            ▼
          </b>
          提醒
        </span>
      )}
    </div>
  );
  const table = { cols: ['时间', unit], rows: hours.slice(0, last + 1).map((v, k) => [`${pad2(k)}:00`, String(v)]) };
  return (
    <ChartBox name="HourArea" c={c} w={w} h={h} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} foot={foot} table={table} frame={frame}>
      <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={aria} onMouseMove={move} onMouseLeave={leave}>
        <Hatch id={uid} />
        <defs>
          <pattern id={`${uid}y`} width="8" height="4" patternUnits="userSpaceOnUse">
            <rect width="8" height="4" className={a.fill} />
            <rect width="8" height="1" className={a.scan} />
          </pattern>
        </defs>
        {[0, max / 2, max].map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={L + PW} y1={Y(v)} y2={Y(v)} className={v ? a.half : s.ax} />
            <text x={L - 6} y={Y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <text x={L} y={T - 6} className={s.zh}>
          {unit}
        </text>
        {Array.from({ length: 9 }, (_, i) => i * 3).map((t) => (
          <g key={`x${t}`}>
            <line x1={X(t)} x2={X(t)} y1={YB} y2={YB + 4} className={s.ax} />
            <text x={X(t)} y={YB + 16} textAnchor="middle">
              {pad2(t)}
            </text>
          </g>
        ))}
        {now != null && <rect x={X(now)} y={T} width={X(24) - X(now)} height={YB - T} fill={`url(#${uid})`} className={a.fut} />}
        {pauses.map(([p0, p1]) => (
          <g key={`p${p0}`} data-pause="">
            <rect x={X(p0)} y={T} width={Math.max(1, X(p1) - X(p0))} height={YB - T} fill={`url(#${uid})`} />
            <text x={(X(p0) + X(p1)) / 2} y={T + 12} textAnchor="middle" className={s.zh}>
              暂停
            </text>
          </g>
        ))}
        {hv != null && <rect x={X(hv)} y={T} width={X(hv + 1) - X(hv)} height={YB - T} className={a.hv} />}
        {top && (
          <>
            <path d={`${top}L${X(Math.min(end, 24)).toFixed(1)} ${YB}L${L} ${YB}Z`} fill={`url(#${uid}y)`} />
            <path d={top} className={a.top} />
            <circle cx={X(Math.min(end, 24))} cy={Y(hours[last]!)} r="3.5" className={a.dot} />
          </>
        )}
        {lines.map((l) => (
          <path key={l.id} d={l.pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)} ${LY(v).toFixed(1)}`).join('')} className={l.dash ? a.dash : a.line} data-line={l.id} />
        ))}
        {marks.map((m) => (
          <path key={`m${m.h}`} d={`M${X(m.h) - 5} ${T - 8}h10l-5 7z`} className={a.mark} data-mark="" />
        ))}
        {now != null && (
          <g data-now="">
            <line x1={X(now)} x2={X(now)} y1={T} y2={YB + 22} className={a.now} />
            <rect x={clampN(X(now), 20, W - 20) - 20} y={YB + 24} width="40" height="15" className={a.plate} />
            <text x={clampN(X(now), 20, W - 20)} y={YB + 35} textAnchor="middle" className={a.plateT}>
              {clock(now)}
            </text>
          </g>
        )}
      </svg>
    </ChartBox>
  );
}

const DEMO_FG = [0, 0, 0, 0, 0, 0, 0, 0, 12, 48, 55, 52, 20, 35, 58, 54, 50, 41, 18, 0, 22, 35, 10, 0];
const DEMO_LINE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 3, 5, 0, 6, 8, 5, 3, 2, 0, 2, 4, 1, 0, 0];
const wave = (f: (t: number) => number, until: number): Array<[number, number]> => Array.from({ length: Math.floor(until * 4) + 1 }, (_, q) => [q / 4, +f(q / 4).toFixed(3)]);

export const HourAreaDemos: Array<{ name: string; props: HourAreaProps }> = [
  { name: 'today', props: { label: '每小时在电脑前的分钟数', name: '在电脑前', unit: '分钟 / 小时', hours: DEMO_FG.map((v, k) => (k < 16 ? v : 0)), max: 60, now: 15 + 40 / 60, pauses: [[12.17, 12.83]], marks: [{ h: 15.5, label: '提醒 1 个' }], tip: (v) => `在电脑前 ${v} 分钟` } },
  { name: 'lines', props: { label: '每小时发言和精神、心情', name: '发言', unit: '句 / 小时', hours: DEMO_LINE, max: 10, lineRange: [-0.4, 1], lines: [{ id: 'e', label: '精神', pts: wave((t) => 0.55 + 0.25 * Math.sin((t - 9) / 4), 24) }, { id: 'v', label: '心情', dash: true, pts: wave((t) => 0.2 + 0.15 * Math.sin((t - 6) / 5), 24) }], tip: (v) => `发言 ${v} 句` } },
  { name: 'empty-day', props: { label: '每小时在电脑前的分钟数', name: '在电脑前', unit: '分钟 / 小时', hours: Array.from({ length: 24 }, () => 0), max: 60, tip: (v) => `在电脑前 ${v} 分钟` } },
];
