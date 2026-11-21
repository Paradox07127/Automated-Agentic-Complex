import { useState, type MouseEvent } from 'react';
import { ChartBox, Hatch, useChart, useSvgId, zh, type ChartCommonProps } from './ChartBox';
import { APPS, CHANNELS, HOURS, HOUR_TOTAL, TOK } from './v3demo';
import { cx, EMPH, fmtN, niceMax, seriesColors, sum, svgFill, ticks } from './v3';
import s from './ChartBox.module.css';
import b from './StackedBars.module.css';

export interface StackBucket {
  key: string;
  label: string;
  parts: Record<string, number>;
}

/** 细柱堆叠：柱宽 ≤ 间距 60%，段间 2 px 缝；类用墨、次墨、chip、斜线纹四档；emph 是类 id 时该类用 trace，是柱 key 时该柱用 trace。 */
export interface StackedBarsProps extends ChartCommonProps {
  buckets: StackBucket[];
  cats: Array<{ id: string; label: string; color?: string }>;
  /** 高，默认 140 */
  h?: number;
  w?: number;
  horizontal?: boolean;
  fmt?: (v: number) => string;
  onPick?: (key: string | null) => void;
  sel?: string | null;
  emph?: string;
}

export function StackedBars({ buckets, cats, h = 140, w, horizontal, fmt = fmtN, onPick, sel, label = '堆叠柱', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: StackedBarsProps) {
  const c = useChart(w);
  const uid = useSvgId();
  const [hb, setHb] = useState<string | null>(null);
  if (!buckets.length && st === 'ok') st = 'empty';
  const bEm = buckets.some((x) => x.key === emph) ? emph : null;
  const cc = seriesColors(cats, bEm ? null : emph, true, !!bEm || cats.some((k) => k.id === emph));
  const colOf = (i: number, x: StackBucket) => (x.key === bEm ? EMPH : cc[i]);
  const opOf = (i: number, x: StackBucket) => (x.key === bEm ? Math.max(0.45, 1 - i * 0.25) : 1);
  const tot = (x: StackBucket) => sum(cats.map((k) => x.parts[k.id]));
  const catTot = cats.map((k) => sum(buckets.map((x) => x.parts[k.id])));
  const tipOf = (x: StackBucket) => {
    const ps = cats.map((k) => [k.label, x.parts[k.id] ?? 0] as const).filter((p) => p[1] > 0).sort((p, q) => q[1] - p[1]);
    const rest = ps.slice(2);
    return [`${x.label} │ 合计 ${fmt(tot(x))}`, ...ps.slice(0, 2).map((p) => `${p[0]}  ${fmt(p[1])}`), ...(rest.length ? [`${rest.length === 1 ? rest[0]![0] : `其他 ${rest.length} 项`}  ${fmt(sum(rest.map((p) => p[1])))}`] : [])].join('\n');
  };
  const aria = `${label}：${buckets.map((x) => `${x.label} ${fmt(tot(x))}`).join('，')}`;
  const foot = cats.length > 1 && (
    <div className={s.lg}>
      {cats.map((k, i) => (
        <span key={k.id} className={k.id === emph ? s.em : undefined}>
          <i style={{ background: cc[i] }} />
          {k.label} <span className={s.num}>{fmt(catTot[i] ?? 0)}</span>
        </span>
      ))}
    </div>
  );
  const table = { cols: ['', ...cats.map((k) => k.label), '合计'], rows: buckets.map((x) => [x.label, ...cats.map((k) => fmt(x.parts[k.id] ?? 0)), fmt(tot(x))]) };
  const pick = (x: StackBucket) => (onPick ? () => onPick(sel === x.key ? null : x.key) : undefined);
  const hover = (x: StackBucket) => (e: MouseEvent) => {
    setHb(x.key);
    c.show(e, tipOf(x));
  };
  const W = c.W;
  const box = { name: 'StackedBars', c, w, h, st, empty, stoppedAt, onRetry, label, foot, table, frame };
  if (horizontal) {
    const LW = Math.min(84, Math.round(W * 0.3));
    const BW = Math.max(10, W - LW - 52 - 16);
    const mx = Math.max(1, ...buckets.map(tot));
    return (
      <ChartBox {...box}>
        <div className={b.hb} role={onPick ? 'group' : 'img'} aria-label={aria}>
          {buckets.map((x) => {
            let at = 0;
            return (
              <div key={x.key} className={cx(b.hbr, sel === x.key && b.on, hb && hb !== x.key && b.dim)} onClick={pick(x)} onMouseMove={hover(x)} onMouseLeave={() => setHb(null)} data-bucket={x.key}>
                <span className={b.hbl} style={{ width: LW }}>
                  {x.label}
                </span>
                <span className={b.hbt} style={{ width: BW }}>
                  {cats.map((k, i) => {
                    const v = x.parts[k.id] ?? 0;
                    const ww = (v / mx) * BW;
                    const el = v > 0 && <i key={k.id} style={{ left: at, width: Math.max(1, ww - 2), background: colOf(i, x), opacity: opOf(i, x) }} />;
                    at += ww;
                    return el;
                  })}
                </span>
                <span className={cx(b.hbv, s.num)}>{fmt(tot(x))}</span>
              </div>
            );
          })}
        </div>
      </ChartBox>
    );
  }
  const narrow = W < 220;
  const L = narrow ? 4 : 30;
  const R = 6;
  const T = 14;
  const PW = Math.max(10, W - L - R);
  const PH = Math.max(10, h - T - 20);
  const n = Math.max(1, buckets.length);
  const mx = niceMax(Math.max(1, ...buckets.map(tot)));
  const bw = PW / n;
  const barW = Math.max(2, Math.min(bw * 0.6, 28));
  const Y = (v: number) => T + (1 - v / mx) * PH;
  const every = Math.max(1, Math.ceil((n * 30) / PW));
  const peak = buckets.reduce<StackBucket | null>((m, x) => (!m || tot(x) > tot(m) ? x : m), null);
  const lastB = buckets[buckets.length - 1];
  const annot = (x: StackBucket) => (x === peak || x === lastB || x.key === bEm || x.key === sel) && tot(x) > 0;
  return (
    <ChartBox {...box}>
      <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} role={onPick ? 'group' : 'img'} aria-label={aria}>
        <Hatch id={uid} />
        {ticks(0, mx, PH < 60 ? 2 : 4).map((v) => (
          <g key={`y${v}`}>
            {v > 0 && <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className={s.grid} />}
            {!narrow && (
              <text x={L - 6} y={Y(v) + 4} textAnchor="end" className={zh(fmt(v))}>
                {fmt(v)}
              </text>
            )}
          </g>
        ))}
        {buckets.map((x, i) => {
          let acc = 0;
          let first = true;
          const x0 = L + i * bw + (bw - barW) / 2;
          return (
            <g key={x.key} className={cx(b.col, hb && hb !== x.key && b.dim)} onMouseMove={hover(x)} onMouseLeave={() => setHb(null)} onClick={pick(x)} data-bucket={x.key}>
              <rect x={L + i * bw} width={bw} y={T} height={PH} fill="transparent" />
              {cats.map((k, ci) => {
                const v = x.parts[k.id] ?? 0;
                if (v <= 0) return null;
                const y0 = Y(acc);
                const y1 = Y(acc + v);
                acc += v;
                const gap = first ? 0 : 2;
                first = false;
                return <rect key={k.id} x={x0} width={barW} y={y1} height={Math.max(1, y0 - y1 - gap)} {...svgFill(colOf(ci, x), uid)} opacity={opOf(ci, x)} />;
              })}
              {sel === x.key && <rect x={x0 - 2} width={barW + 4} y={Y(tot(x)) - 2} height={Y(0) - Y(tot(x)) + 2} className={s.selBox} />}
              {annot(x) && (
                <text x={x0 + barW / 2} y={Y(tot(x)) - 4} textAnchor="middle" className={cx(s.end, (x.key === bEm || x === peak) && s.key)}>
                  {fmt(tot(x))}
                </text>
              )}
              {i % every === 0 && (
                <text x={x0 + barW / 2} y={h - 4} textAnchor="middle" className={zh(x.label)}>
                  {x.label}
                </text>
              )}
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} className={s.ax} />
      </svg>
    </ChartBox>
  );
}

const k = (v: number) => `${Math.round(v / 1000)} k`;

export const StackedBarsDemos: Array<{ name: string; props: StackedBarsProps }> = [
  { name: 'emph-bucket', props: { label: '按小时前台分钟', buckets: HOUR_TOTAL, cats: [{ id: 'min', label: '分钟' }], h: 96, fmt: String, emph: 'h14' } },
  { name: 'categories', props: { label: '按小时前台 App 分钟', buckets: HOURS, cats: APPS, h: 96, fmt: String } },
  { name: 'horizontal', props: { label: '今日 token 按通道', horizontal: true, buckets: CHANNELS, cats: TOK, fmt: k, emph: 'cache' } },
  { name: 'empty', props: { label: '按小时前台分钟', empty: '今天还没有前台记录', buckets: [], cats: [{ id: 'min', label: '分钟' }] } },
];
