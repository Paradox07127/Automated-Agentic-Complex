import { useState, type MouseEvent } from 'react';
import { ChartBox, Hatch, SvgRuler, useChart, useSvgId, zh, type ChartCommonProps } from './ChartBox';
import { at, DAY0, ENERGY, MOOD, NOW } from './v3demo';
import { clampN, cx, fmtN, hm, hms, seriesColors, ticks } from './v3';
import { Btn } from '../ui/Btn';
import s from './ChartBox.module.css';

export type Pt = [number, number | null];

export interface LineSeries {
  id: string;
  label: string;
  /** [时间, 值]；值为 null 时断线，断开处画斜纹 */
  pts: Pt[];
  color?: string;
}

/** 一条参考线：label 缺省为「name v」 */
export interface LineLimit {
  v: number;
  label?: string;
  /** 读屏名，缺省「上限」 */
  name?: string;
  /** 色调：warning 缺电橙，danger 深墨（图表不用红）；不给是墨色 */
  tone?: 'warning' | 'danger';
}

/** 多序列时间折线：墨色阶，emph 那条用 trace；只标端点和极值；limit 画上限虚线并直接标注。 */
export interface LineChartProps extends ChartCommonProps {
  series: LineSeries[];
  t0?: number;
  t1?: number;
  yMin?: number;
  yMax?: number;
  /** 高，默认 120 */
  h?: number;
  /** 宽；不给就随父容器 */
  w?: number;
  /** 竖细线加标签 */
  marks?: Array<{ t: number; label: string }>;
  fmtY?: (v: number | null) => string;
  fmtT?: (t: number) => string;
  /** 给强调序列（或第一条）铺底 */
  area?: boolean;
  now?: number;
  /** 要强调的序列 id */
  emph?: string;
  /** 参考线（上限、注意线），一条或多条 */
  limit?: LineLimit | readonly LineLimit[];
  /** 不写 y 轴刻度、端点和极值数值，数值只在图例里 */
  bare?: boolean;
}

export function LineChart({ series, t0, t1, yMin, yMax, h = 120, w, marks = [], fmtY = fmtN, fmtT, area, now, label = '折线', st = 'ok', empty, stoppedAt, onRetry, emph, limit, frame, bare }: LineChartProps) {
  const limits: readonly LineLimit[] = limit == null ? [] : 'v' in limit ? [limit] : limit;
  const c = useChart(w);
  const uid = useSvgId();
  const [hv, setHv] = useState<number | null>(null);
  const all = series.flatMap((x) => x.pts.filter((p): p is [number, number] => p[1] != null));
  if (!all.length) {
    if (st === 'ok') st = 'empty';
    all.push([t0 ?? 0, 0], [t1 ?? 1, 1]);
  }
  const a = t0 ?? Math.min(...all.map((p) => p[0]));
  const b = t1 ?? Math.max(...all.map((p) => p[0]));
  const lo = yMin ?? Math.min(...all.map((p) => p[1]), ...limits.map((l) => l.v));
  const hi = yMax ?? Math.max(...all.map((p) => p[1]), ...limits.map((l) => l.v));
  const W = c.W;
  const narrow = bare || W < 260;
  const L = narrow ? 6 : 34;
  const R = narrow ? 6 : 36;
  const T = marks.length ? 18 : 8;
  const B = 20;
  const PW = Math.max(10, W - L - R);
  const PH = Math.max(10, h - T - B);
  const X = (t: number) => L + ((t - a) / (b - a || 1)) * PW;
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * PH;
  const cols = seriesColors(series, emph);
  const key = series.findIndex((x) => x.id === emph);
  const k0 = key >= 0 ? key : 0;
  const pathOf = (pts: Pt[]) => {
    let d = '';
    let pen = false;
    for (const [t, v] of pts) {
      if (v == null) pen = false;
      else {
        d += `${pen ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`;
        pen = true;
      }
    }
    return d;
  };
  const lastP = (x: LineSeries) => [...x.pts].reverse().find((p): p is [number, number] => p[1] != null);
  const fT = fmtT ?? (b - a <= 15 * 60e3 ? hms : hm);
  const near = (x: LineSeries, t: number) => x.pts.reduce<[number, number] | null>((best, p) => (p[1] != null && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) ? [p[0], p[1]] : best), null);
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = a + (clampN(((e.clientX - r.left) * W) / (r.width || W) - L, 0, PW) / PW) * (b - a);
    const hit = series.map((x) => near(x, t));
    const tt = hit[0] ? hit[0][0] : t;
    setHv(tt);
    c.show(e, [fT(tt), ...series.slice(0, 3).map((x, i) => `${x.label}  ${fmtY(hit[i]?.[1] ?? null)}`)].join('\n'));
  };
  const aria = `${label}：${series
    .map((x) => {
      const vs = x.pts.map((p) => p[1]).filter((v): v is number => v != null);
      return `${x.label} 最新 ${fmtY(lastP(x)?.[1] ?? null)}，最高 ${fmtY(Math.max(...vs))}，最低 ${fmtY(Math.min(...vs))}`;
    })
    .join('；')}${limits.map((l) => `；${l.name ?? '上限'} ${fmtY(l.v)}`).join('')}`;
  const base = Y(clampN(0, lo, hi));
  const gaps: Array<[number, number]> = [];
  for (const x of series) {
    let prev: Pt | null = null;
    let open = false;
    for (const p of x.pts) {
      if (p[1] == null) {
        if (prev) open = true;
      } else {
        if (open && prev) gaps.push([prev[0], p[0]]);
        open = false;
        prev = p;
      }
    }
  }
  const ends = series
    .slice(0, 3)
    .flatMap((x, i) => {
      const p = lastP(x);
      return p ? [{ i, x: X(p[0]), y: Y(p[1]), v: p[1], s: x, ly: 0 }] : [];
    })
    .sort((p, q) => p.y - q.y);
  ends.forEach((e, j) => (e.ly = j ? Math.max(e.y, ends[j - 1]!.ly + 11) : e.y));
  const ks = series[k0];
  const kv = ks ? ks.pts.filter((p): p is [number, number] => p[1] != null) : [];
  const peak = kv.length > 2 ? kv.reduce((m, p) => (p[1] > m[1] ? p : m), kv[0]!) : null;
  const kl = ks && lastP(ks);
  const showPeak = !bare && peak && kl && peak[0] !== kl[0] && Math.abs(X(peak[0]) - X(kl[0])) > 24 && X(peak[0]) > L + 24;
  const yt = ticks(lo, hi, Math.max(2, Math.min(4, Math.floor(PH / 26))));
  const foot = series.length > 1 && (
    <div className={s.lg}>
      {series.map((x, i) => (
        <span key={x.id} className={x.id === emph ? s.em : undefined}>
          <i className={s.ln} style={{ background: cols[i] }} />
          {x.label} <span className={s.num}>{fmtY(lastP(x)?.[1] ?? null)}</span>
        </span>
      ))}
    </div>
  );
  const table = { cols: ['时间', ...series.map((x) => x.label)], rows: (series[0]?.pts ?? []).map((p) => [fT(p[0]), ...series.map((x) => { const q = x.pts.find((y) => y[0] === p[0]); return q && q[1] != null ? fmtY(q[1]) : '—'; })]) };
  const first = ks?.pts.find((p) => p[1] != null);
  return (
    <ChartBox name="LineChart" c={c} w={w} h={h} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} foot={foot} table={table} frame={frame}>
      <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={aria} onMouseMove={move} onMouseLeave={() => setHv(null)}>
        <Hatch id={uid} />
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={L + PW} y1={Y(v)} y2={Y(v)} className={s.grid} />
            {!narrow && (
              <text x={L - 6} y={Y(v) + 4} textAnchor="end" className={zh(fmtY(v))}>
                {fmtY(v)}
              </text>
            )}
          </g>
        ))}
        {gaps.map((g, i) => (
          <rect key={`g${i}`} x={X(g[0])} width={Math.max(1, X(g[1]) - X(g[0]))} y={T} height={PH} fill={`url(#${uid})`} />
        ))}
        <line x1={L} x2={L + PW} y1={T + PH} y2={T + PH} className={s.ax} />
        <SvgRuler t0={a} t1={b} X={X} y={T + PH} PW={PW} fmtT={fmtT} />
        {marks
          .filter((m) => m.t >= a && m.t <= b)
          .map((m) => {
            // A label that would run past the plot's right end reads leftward from its line; 12 px is one CJK glyph.
            const inward = X(m.t) + 3 + m.label.length * 12 > L + PW;
            return (
              <g key={`m${m.t}`}>
                <line x1={X(m.t)} x2={X(m.t)} y1={T - 2} y2={T + PH} className={s.mark} />
                {!narrow && (
                  <text x={inward ? X(m.t) - 3 : X(m.t) + 3} y={T - 6} textAnchor={inward ? 'end' : undefined} className={cx(s.zh, s.markT)}>
                    {m.label}
                  </text>
                )}
              </g>
            );
          })}
        {limits.map((l, i) => {
          const limT = l.label ?? `${l.name ?? '上限'} ${fmtY(l.v)}`;
          return (
            <g key={`l${i}`} data-limit={l.tone ?? ''} className={l.tone && s[l.tone]}>
              <line x1={L} x2={L + PW} y1={Y(l.v)} y2={Y(l.v)} className={s.lim} />
              <text x={L + 4} y={Y(l.v) - 4} className={zh(limT, s.limT, s.halo)}>
                {limT}
              </text>
            </g>
          );
        })}
        {area && ks && kl && first && <path d={`${pathOf(ks.pts)}L${X(kl[0]).toFixed(1)} ${base}L${X(first[0]).toFixed(1)} ${base}Z`} fill={cols[k0]} opacity=".1" />}
        {series.map((x, i) => (
          <path key={x.id} d={pathOf(x.pts)} fill="none" stroke={cols[i]} strokeWidth={i === k0 ? 2 : 1.5} strokeLinejoin="miter" strokeLinecap="square" data-series={x.id} />
        ))}
        {ends.map((e) => (
          <g key={`d${e.s.id}`}>
            <circle cx={e.x} cy={e.y} r={e.i === k0 ? 3 : 2.25} fill={cols[e.i]} />
            {!narrow && (
              <text x={e.x + 6} y={e.ly + 4} className={cx(s.end, e.i === k0 && s.key)}>
                {fmtY(e.v)}
              </text>
            )}
          </g>
        ))}
        {showPeak && ks && (
          <g>
            <circle cx={X(peak[0])} cy={Y(peak[1])} r="2.25" fill="none" stroke={cols[k0]} strokeWidth="1.25" />
            <text x={X(peak[0])} y={Y(peak[1]) - 6} textAnchor="middle" className={s.ext}>
              {fmtY(peak[1])}
            </text>
          </g>
        )}
        {now != null && now >= a && now <= b && <line x1={X(now)} x2={X(now)} y1={T} y2={T + PH} className={s.now} />}
        {hv != null && (
          <g>
            <line x1={X(hv)} x2={X(hv)} y1={T} y2={T + PH} className={s.hair} />
            {series.map((x, i) => {
              const p = near(x, hv);
              return p && <circle key={`h${x.id}`} cx={X(p[0])} cy={Y(p[1])} r="3.5" fill="var(--v3-bg)" stroke={cols[i]} strokeWidth="1.5" />;
            })}
          </g>
        )}
      </svg>
    </ChartBox>
  );
}

const fmt1 = (v: number | null) => (v == null ? '—' : (Math.abs(v) < 0.05 ? 0 : v).toFixed(1));
const pair: LineSeries[] = [
  { id: 'e', label: '精神', pts: ENERGY },
  { id: 'm', label: '心情', pts: MOOD },
];

export const LineChartDemos: Array<{ name: string; props: LineChartProps }> = [
  { name: 'mono', props: { label: '精神和心情 24 小时', series: pair, t0: DAY0, t1: NOW, yMin: -0.5, yMax: 1, h: 96, fmtY: fmt1, marks: [{ t: at(9, 0), label: '起床' }, { t: at(12, 0), label: '午饭' }] } },
  { name: 'emph', props: { label: '精神和心情 24 小时', emph: 'e', area: true, series: pair, t0: DAY0, t1: NOW, yMin: -0.5, yMax: 1, h: 96, fmtY: fmt1 } },
  { name: 'limit', props: { label: '每分钟帧耗时', series: [{ id: 'f', label: '帧耗时', pts: Array.from({ length: 30 }, (_, i) => [at(14, i), 9 + ((i * 7) % 11) / 2] as Pt) }], h: 110, now: at(14, 29), limit: { v: 16.7, label: '预算 16.7 ms' }, fmtY: (v) => (v == null ? '—' : v.toFixed(1)) } },
  {
    name: 'limit-tones',
    props: {
      label: '后台进程内存',
      series: [{ id: 'm', label: '内存', pts: Array.from({ length: 30 }, (_, i) => [at(14, i), 300 + ((i * 37) % 160)] as Pt) }],
      h: 110,
      yMin: 200,
      yMax: 560,
      limit: [
        { v: 420, label: '注意 420 MB', name: '注意线', tone: 'warning' },
        { v: 500, label: '过高 500 MB', name: '过高线', tone: 'danger' },
      ],
      fmtY: (v) => (v == null ? '—' : `${Math.round(v)}`),
    },
  },
  { name: 'empty', props: { label: '空态', empty: '今天还没有数据', series: [], h: 40 } },
  { name: 'empty-action', props: { label: '帧耗时', empty: <>还没有帧记录 <Btn size="sm">开始记录</Btn></>, series: [], h: 40 } },
];
