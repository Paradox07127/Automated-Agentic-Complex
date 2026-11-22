import { useState, type MouseEvent, type ReactNode } from 'react';
import s from './Curve.module.css';

export interface CurveLine {
  v: number;
  label: string;
  tone: 'ink' | 'warn' | 'bad';
}

export interface CurveSeries {
  id: string;
  label: string;
  pts: ReadonlyArray<readonly [number, number | null]>;
  /** main: the yellow line (ink in the light theme); ink: a grey second line */
  tone: 'main' | 'ink';
  area?: boolean;
  /** Seconds above this value get a light red pad behind them. */
  over?: number;
}

/** The light gridded face of a statistic plot: reference lines, curves with their end dots, a time axis; hover reads the moment. */
export interface CurveProps {
  label: string;
  series: CurveSeries[];
  t0: number;
  t1: number;
  min: number;
  max: number;
  lines?: CurveLine[];
  /** Where the reference lines carry their label, default left */
  lineLabels?: 'left' | 'right';
  axis: Array<{ t: number; label: string }>;
  /** Writes the scale's top and bottom value at the left. */
  fmtY?: (v: number) => string;
  fmt: (v: number) => string;
  fmtT: (t: number) => string;
  /** The data stopped: the curve dashes and fades. */
  stale?: boolean;
  /** Drawn over the face instead of the curves (too few samples, no data). */
  note?: ReactNode;
}

const W = 1000;
const H = 100;

export function Curve({ label, series, t0, t1, min, max, lines = [], lineLabels = 'left', axis, fmtY, fmt, fmtT, stale, note }: CurveProps) {
  const [hv, setHv] = useState<number | null>(null);
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (v: number) => ((max - Math.min(max, Math.max(min, v))) / (max - min)) * H;
  const pathOf = (pts: CurveSeries['pts']) => {
    let d = '';
    let pen = false;
    for (const [t, v] of pts) {
      if (v == null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const head = series[0];
  const ends = series.map((sr) => [...sr.pts].reverse().find((p) => p[1] != null));
  const move = (e: MouseEvent<HTMLDivElement>) => {
    if (!head || head.pts.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left) / Math.max(1, r.width)) * span;
    let best = 0;
    head.pts.forEach((p, i) => {
      if (Math.abs(p[0] - t) < Math.abs((head.pts[best]?.[0] ?? 0) - t)) best = i;
    });
    setHv(best);
  };
  const at = hv != null ? head?.pts[hv]?.[0] : undefined;
  const last = ends[0]?.[1];
  return (
    <div className={s.curve} data-y={fmtY ? '' : undefined} data-stale={stale || undefined}>
      <div className={s.plot} role="img" aria-label={`${label}${last != null ? `，现在 ${fmt(last)}` : ''}`} onMouseMove={move} onMouseLeave={() => setHv(null)}>
        <svg className={s.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {series
            .filter((sr) => sr.over != null)
            .flatMap((sr) => {
              const step = sr.pts.length > 1 ? W / (sr.pts.length - 1) : W;
              return sr.pts.map(([t, v], i) => {
                if (v == null || v <= (sr.over ?? Infinity)) return null;
                const a = Math.max(0, x(t) - step / 2);
                return <rect key={`${sr.id}${i}`} className={s.over} x={a} y={0} width={Math.min(W, x(t) + step / 2) - a} height={H} />;
              });
            })}
          {lines.map((l) => (
            <line key={l.label} className={s.ref} data-tone={l.tone} x1={0} x2={W} y1={y(l.v)} y2={y(l.v)} vectorEffect="non-scaling-stroke" />
          ))}
          {!note &&
            series.map((sr) => {
              const d = pathOf(sr.pts);
              const first = sr.pts.find((p) => p[1] != null);
              const lastPt = [...sr.pts].reverse().find((p) => p[1] != null);
              return (
                <g key={sr.id} data-tone={sr.tone}>
                  {sr.area && d && first && lastPt && <path className={s.area} d={`${d}L${x(lastPt[0]).toFixed(1)} ${H}L${x(first[0]).toFixed(1)} ${H}Z`} />}
                  <path className={s.line} d={d} vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
        </svg>
        {fmtY && (
          <>
            <span className={s.yl} style={{ top: '0%' }} aria-hidden="true">
              {fmtY(max)}
            </span>
            <span className={s.yl} style={{ top: '100%' }} aria-hidden="true">
              {fmtY(min)}
            </span>
          </>
        )}
        {lines.map((l) => (
          <span key={l.label} className={s.refLabel} data-tone={l.tone} data-at={lineLabels} style={{ top: `${y(l.v)}%` }}>
            {l.label}
          </span>
        ))}
        <i className={s.base} aria-hidden="true" />
        {!note &&
          series.map((sr, i) => {
            const e = ends[i];
            return e && e[1] != null ? <i key={sr.id} className={s.dot} data-tone={sr.tone} style={{ left: `${x(e[0]) / 10}%`, top: `${y(e[1])}%` }} aria-hidden="true" /> : null;
          })}
        {note && <span className={s.note}>{note}</span>}
        {!note && at != null && hv != null && (
          <>
            <i className={s.cursor} style={{ left: `${x(at) / 10}%` }} aria-hidden="true" />
            <span className={s.tip} style={{ left: `${x(at) / 10}%` }} data-flip={x(at) > W * 0.7 || undefined} role="status">
              <span className={s.tipT}>{fmtT(at)}</span>
              {series.map((sr) => {
                const v = sr.pts[hv]?.[1];
                return (
                  <span key={sr.id} data-tone={sr.tone}>
                    {sr.label} <b className="num">{v == null ? '—' : fmt(v)}</b>
                  </span>
                );
              })}
            </span>
          </>
        )}
      </div>
      <div className={s.axis} aria-hidden="true">
        {axis.map((a) => (
          <span key={a.label} style={{ left: `${x(a.t) / 10}%` }} data-end={a.t >= t1 || undefined} data-start={a.t <= t0 || undefined}>
            {a.label}
          </span>
        ))}
      </div>
    </div>
  );
}
