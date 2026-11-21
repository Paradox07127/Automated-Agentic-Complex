import { useState, type MouseEvent } from 'react';
import { useWidth } from '../../charts/useWidth';
import { formatClock, formatMs, type Turn } from '../../domain';
import { sourceLabel } from './model';
import { RESULT_TEXT } from './labels';
import styles from './Turns.module.css';

const YT: ReadonlyArray<[number, string]> = [
  [100, '100 ms'],
  [1000, '1 s'],
  [10000, '10 s'],
  [60000, '1 min'],
];
const HOUR = 3_600_000;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hms = (t: number) => formatClock(t, { seconds: true });
const dayOf = (t: number) => `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`;

export interface DgTurnsProps {
  turns: readonly Turn[];
  t0: number;
  t1: number;
  /** 7-day scale: day ticks and 6-hour failure bins. */
  day: boolean;
  sel: Turn | null;
  onPick: (t: Turn) => void;
}

/** Turn timeline: ruler on top (hour / 15-minute ticks, day / 6-hour on 7 days), the now flag, the selected cursor; y is the turn time on a log scale. */
export function DgTurns({ turns, t0, t1, day, sel, onPick }: DgTurnsProps) {
  const [ref, W] = useWidth<HTMLDivElement>(960);
  const [hv, setHv] = useState<{ x: number; p: Turn | null; t: number } | null>(null);
  const L = 48;
  const R = 10;
  const RH = 22;
  const PT = 30;
  const PH = 92;
  const FY = PT + PH + 9;
  const H = FY + 18;
  const PW = Math.max(1, W - L - R);
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * PW;
  const lg = (ms: number) => Math.log10(clamp(ms, 100, 60000));
  const Y = (ms: number) => PT + 4 + (1 - (lg(ms) - 2) / (Math.log10(60000) - 2)) * (PH - 8);
  const ticks: Array<{ t: number; major: boolean }> = [];
  if (day) {
    const d = new Date(t0);
    d.setHours(0, 0, 0, 0);
    for (let t = d.getTime(); t <= t1; t += 6 * HOUR) if (t >= t0) ticks.push({ t, major: new Date(t).getHours() === 0 });
  } else {
    const step = HOUR / 4;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push({ t, major: new Date(t).getMinutes() === 0 });
  }
  const per = day ? PW / 7 : PW / 24;
  const lab = day ? 1 : ([1, 2, 3, 4, 6].find((k) => per * k >= 48) ?? 6);
  const labOf = (t: number) => (day ? dayOf(t) : formatClock(t));
  const showLab = (t: number) => (day ? new Date(t).getHours() === 0 : new Date(t).getHours() % lab === 0);
  const minor = day || per / 4 >= 5;
  const slot = day ? 6 * HOUR : HOUR;
  const ns = Math.ceil((t1 - t0) / slot);
  const fails = Array.from({ length: ns }, (_, i) => turns.filter((p) => p.result === 'failed' && p.started_at >= t0 + i * slot && p.started_at < t0 + (i + 1) * slot).length);
  const fmx = Math.max(1, ...fails);
  const near = (mx: number, my: number | null) => {
    let best: Turn | null = null;
    let bd = 12;
    for (const p of turns) {
      const d = Math.hypot(X(p.started_at) - mx, my == null ? 0 : Y(p.duration_ms) - my);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  const loc = (e: MouseEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const [mx, my] = loc(e);
    if (mx < L || mx > W - R) return setHv(null);
    setHv({ x: mx, p: near(mx, my), t: t0 + ((mx - L) / PW) * (t1 - t0) });
  };
  const click = (e: MouseEvent<SVGSVGElement>) => {
    const [mx, my] = loc(e);
    const p = near(mx, my) ?? near(mx, null);
    if (p) onPick(p);
  };
  const shape = (p: Turn) => {
    const x = X(p.started_at);
    const y = Y(p.duration_ms);
    const on = hv?.p === p;
    if (p.result === 'failed') return <rect key={p.id} x={x - 2.5} y={y - 2.5} width="5" height="5" className={styles.pf} data-on={on || undefined} />;
    if (p.result === 'interrupted') return <rect key={p.id} x={x - 2.5} y={y - 2.5} width="5" height="5" className={styles.pi} data-on={on || undefined} />;
    if (p.result === 'running') return <circle key={p.id} cx={x} cy={y} r="3" className={styles.pr} data-on={on || undefined} />;
    if (p.result === 'skipped') return <circle key={p.id} cx={x} cy={y} r="1.5" className={styles.ps} />;
    if (p.result === 'unknown') return <path key={p.id} d={`M${x} ${y - 3} l3 5 h-6 Z`} className={styles.pu} />;
    return <circle key={p.id} cx={x} cy={y} r={on ? 3.2 : 2.2} className={styles.po} data-on={on || undefined} />;
  };
  const xs = sel && sel.started_at >= t0 && sel.started_at <= t1 ? X(sel.started_at) : null;
  const xn = X(t1);
  const nFail = fails.reduce((a, b) => a + b, 0);
  return (
    <div ref={ref} className={styles.turns}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`轮次时间轴：${turns.length} 轮，失败 ${nFail} 轮${sel ? `，已选中 ${hms(sel.started_at)}` : ''}`}
        onMouseMove={move}
        onMouseLeave={() => setHv(null)}
        onClick={click}
      >
        <line x1={L} x2={W - R} y1={RH} y2={RH} className={styles.ax} />
        {ticks.map(({ t, major }) =>
          major || minor ? (
            <g key={t}>
              <line x1={X(t)} x2={X(t)} y1={RH} y2={RH - (major ? (showLab(t) ? 9 : 6) : 3)} className={major ? styles.tkm : styles.tk} />
              {major && showLab(t) && X(t) + 34 < xn - 40 && (
                <text x={X(t) + 3} y={RH - 11} className={styles.tl}>
                  {labOf(t)}
                </text>
              )}
            </g>
          ) : null,
        )}
        {YT.map(([ms, l]) => (
          <g key={ms}>
            <line x1={L} x2={W - R} y1={Y(ms)} y2={Y(ms)} className={styles.gr} />
            <text x={L - 6} y={Y(ms) + 3.5} textAnchor="end" className={styles.yl}>
              {l}
            </text>
          </g>
        ))}
        {turns.map(shape)}
        <text x={L - 6} y={FY + 5} textAnchor="end" className={styles.yz}>
          失败
        </text>
        <line x1={L} x2={W - R} y1={FY + 7.5} y2={FY + 7.5} className={styles.gr} />
        {fails.map((f, i) =>
          f > 0 ? <rect key={`f${i}`} x={X(t0 + i * slot) + 1} width={Math.max(1, PW / ns - 2)} y={FY + 2} height="4" className={styles.fb} style={{ opacity: 0.4 + (0.6 * f) / fmx }} /> : null,
        )}
        {hv && <line x1={hv.p ? X(hv.p.started_at) : hv.x} x2={hv.p ? X(hv.p.started_at) : hv.x} y1={RH} y2={FY + 8} className={styles.hair} />}
        {xs != null && sel && (
          <g>
            <line x1={xs} x2={xs} y1={RH} y2={FY + 8} className={styles.cl} />
            <circle cx={xs} cy={Y(sel.duration_ms)} r="5.5" className={styles.cr} />
            <rect x={xs - (xs > W - 70 ? 56 : 0)} y={H - 13} width="56" height="13" className={styles.cf} />
            <text x={xs - (xs > W - 70 ? 53 : -3)} y={H - 3} className={styles.ct}>
              {hms(sel.started_at)}
            </text>
          </g>
        )}
        <g>
          <line x1={xn} x2={xn} y1={RH - 4} y2={FY + 8} className={styles.nl} />
          <rect x={xn - 36} y="0" width="36" height="14" className={styles.nf} />
          <text x={xn - 33} y="10.5" className={styles.nt}>
            {formatClock(t1)}
          </text>
        </g>
      </svg>
      {hv && (
        <div className={styles.tip} style={{ left: clamp(hv.x + 12, 0, W - 190) }}>
          {hv.p ? (
            <>
              <b className="num">{hms(hv.p.started_at)}</b>
              <span>
                {sourceLabel(hv.p.source)} │ {RESULT_TEXT[hv.p.result]}
              </span>
              <span className="num">{formatMs(hv.p.duration_ms)}</span>
              <span className={styles.t3}>点击回放此轮</span>
            </>
          ) : (
            <b className="num">{day ? `${dayOf(hv.t)} ${formatClock(hv.t)}` : formatClock(hv.t)}</b>
          )}
        </div>
      )}
    </div>
  );
}
