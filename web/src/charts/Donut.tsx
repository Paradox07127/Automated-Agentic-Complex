import { useState } from 'react';
import { ChartBox, Hatch, useChart, useSvgId, type ChartCommonProps } from './ChartBox';
import { TOK, tokSum } from './v3demo';
import { cx, fmtN, seriesColors, sum, svgFill } from './v3';
import s from './ChartBox.module.css';
import d from './Donut.module.css';

export interface DonutPart {
  id: string;
  label: string;
  v: number;
  color?: string;
}

/** 环形占比（≤ 5 段时用）：墨、次墨、chip、斜线纹四档，emph 那段用 trace；悬停环或图例高亮一段。 */
export interface DonutProps extends ChartCommonProps {
  parts: DonutPart[];
  /** 边长，默认 120 */
  size?: number;
  center?: { value: string; label: string };
  fmt?: (v: number) => string;
  /** 右侧图例，默认开 */
  legend?: boolean;
  emph?: string;
}

export function Donut({ parts, size = 120, center, fmt = fmtN, legend = true, label = '占比', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: DonutProps) {
  const c = useChart(undefined, size);
  const uid = useSvgId();
  const [hv, setHv] = useState<string | null>(null);
  if (!parts.some((p) => p.v > 0) && st === 'ok') st = 'empty';
  const cols = seriesColors(parts, emph, true);
  const total = sum(parts.map((p) => p.v)) || 1;
  const r = size / 2 - 3;
  const th = Math.max(7, Math.round(size * 0.11));
  const m = size / 2;
  const pctOf = (v: number) => `${Math.round((v / total) * 100)}%`;
  const live = parts.filter((p) => p.v > 0);
  const gapA = live.length > 1 ? 2.5 / r : 0;
  const P = (rr: number, a: number) => `${(m + rr * Math.cos(a)).toFixed(2)} ${(m + rr * Math.sin(a)).toFixed(2)}`;
  const arc = (a1: number, a2: number, ro: number, ri: number) => {
    // A full turn is two half arcs per edge: SVG drops an arc whose endpoints coincide.
    if (a2 - a1 >= Math.PI * 2 - 1e-6) {
      const h = a1 + Math.PI;
      return `M${P(ro, a1)}A${ro} ${ro} 0 0 1 ${P(ro, h)}A${ro} ${ro} 0 0 1 ${P(ro, a1)}ZM${P(ri, a1)}A${ri} ${ri} 0 0 0 ${P(ri, h)}A${ri} ${ri} 0 0 0 ${P(ri, a1)}Z`;
    }
    const big = a2 - a1 > Math.PI ? 1 : 0;
    return `M${P(ro, a1)}A${ro} ${ro} 0 ${big} 1 ${P(ro, a2)}L${P(ri, a2)}A${ri} ${ri} 0 ${big} 0 ${P(ri, a1)}Z`;
  };
  let a0 = -Math.PI / 2;
  const segs = live.map((p) => {
    const a = (p.v / total) * Math.PI * 2;
    const seg = { p, a1: a0 + gapA / 2, a2: a0 + Math.max(a - gapA / 2, gapA / 2 + 0.001) };
    a0 += a;
    return seg;
  });
  const colOf = (p: DonutPart) => cols[parts.indexOf(p)];
  const aria = `${label}：${parts.map((p) => `${p.label} ${fmt(p.v)}（${pctOf(p.v)}）`).join('，')}`;
  const table = { cols: ['', '数值', '占比'], rows: parts.map((p) => [p.label, fmt(p.v), pctOf(p.v)]) };
  return (
    <ChartBox name="Donut" c={c} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} h={size} table={table} frame={frame} style={{ width: 'auto' }}>
      <div className={d.in} onMouseLeave={() => setHv(null)}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={aria}>
          <Hatch id={uid} />
          <circle cx={m} cy={m} r={r - th / 2} fill="none" className={d.track} strokeWidth={th} />
          {segs.map((g) => (
            <path
              key={g.p.id}
              d={arc(g.a1, g.a2, hv === g.p.id ? r + 2 : r, r - th)}
              {...svgFill(colOf(g.p), uid)}
              opacity={hv && hv !== g.p.id ? 0.3 : 1}
              data-part={g.p.id}
              onMouseMove={(e) => {
                setHv(g.p.id);
                c.show(e, `${g.p.label}\n${fmt(g.p.v)} │ ${pctOf(g.p.v)}`);
              }}
            />
          ))}
          {center && (
            <g>
              <text x={m} y={m + 2} textAnchor="middle" className={d.value}>
                {center.value}
              </text>
              <text x={m} y={m + 18} textAnchor="middle" className={cx(s.zh, d.caption)}>
                {center.label}
              </text>
            </g>
          )}
        </svg>
        {legend && (
          <div className={d.lg}>
            {parts.map((p) => (
              <button type="button" key={p.id} className={cx(d.li, hv && hv !== p.id && d.dim, p.id === emph && d.em)} onMouseEnter={() => setHv(p.id)} onMouseLeave={() => setHv(null)} onFocus={() => setHv(p.id)} onBlur={() => setHv(null)}>
                <i style={{ background: colOf(p) }} />
                <span className={d.grow}>{p.label}</span>
                <span className={cx(s.num, d.v)}>{fmt(p.v)}</span>
                <span className={cx(s.num, d.v, d.pct)}>{pctOf(p.v)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </ChartBox>
  );
}

const k = (v: number) => `${Math.round(v / 1000)} k`;
const tok = TOK.map((t) => ({ ...t, v: tokSum(t.id) }));

export const DonutDemos: Array<{ name: string; props: DonutProps }> = [
  { name: 'emph', props: { label: '今日 token 组成', size: 104, emph: 'new', parts: tok, center: { value: k(sum(tok.map((t) => t.v))), label: '今天' }, fmt: k } },
  { name: 'plain', props: { label: '今日 token 组成', size: 96, legend: false, parts: tok, fmt: k } },
  { name: 'empty', props: { label: '今日 token 组成', empty: '今天还没有调用模型', parts: [{ id: 'new', label: '新输入', v: 0 }] } },
];
