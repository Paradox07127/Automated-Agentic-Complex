import { Fragment, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useWidth } from '../../charts/useWidth';
import { formatClock, type StateCause, type StatePoint } from '../../domain';
import type { Beat, BeatSource } from '../character/api';
import { BEAT_SOURCE, BEHAVIOR, CAUSE_SHORT, CAUSES } from '../character/labels';
import styles from './Chart.module.css';

export interface StateDecisionChartProps {
  /** `/character/state/history`, oldest first. */
  log: StatePoint[];
  causes: StateCause[];
  beats: Beat[];
  t0: number;
  t1: number;
  /** Hours between axis labels. */
  step: number;
  /** Where the data stops after agentd went away; hatched from here to t1. */
  stoppedAt?: number | undefined;
  /** Said in the curve area when there is no curve. */
  noCurve?: string | undefined;
  /** Said in the lanes when there is no decision. */
  noBeats?: string | undefined;
  /** The fixed cursor: a decision's or a cause's time. */
  pick: number | null;
  onPick: (at: number) => void;
  label: string;
}

const HOUR = 3600_000;
const LANES: BeatSource[] = ['model', 'rules', 'hard'];
const [L, R, CT, LG, LH, AX] = [62, 8, 24, 10, 22, 22];
const [V_MIN, V_MAX] = [-0.4, 1];
/** Energy under this reads 困 (character_state.py's sleepy line). */
const SLEEPY = 0.35;
/** At most this many cause tags on top of the curve. */
const TAGS = 4;

export const causeName = (c: StateCause) => CAUSES[c.cause] ?? c.cause;
const shortName = (c: StateCause) => CAUSE_SHORT[c.cause] ?? causeName(c);
export const attrName = (c: StateCause) => (c.attr === 'energy' ? '精神' : '心情');
export const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`;

/** The curve's value at `t`, straight between logged points. */
function valueAt(log: StatePoint[], t: number, k: 'energy' | 'valence'): number | null {
  const i = log.findIndex((p) => p.at >= t);
  if (i < 0) return log.at(-1)?.[k] ?? null;
  const b = log[i]!;
  const a = log[i - 1];
  if (!a) return b[k];
  return a[k] + ((b[k] - a[k]) * (t - a.at)) / (b.at - a.at || 1);
}

/** The curve's height follows the window: the rest of the page keeps its place, the curve gets what is left (96–290). */
function useCurveHeight(): number {
  const read = () => Math.max(96, Math.min(290, (typeof window === 'undefined' ? 900 : window.innerHeight) - 545));
  const [h, setH] = useState(read);
  useEffect(() => {
    const on = () => setH(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

/** Local clock hours from t0 on, every `step` hours, before the last 48 minutes (the now tag sits there). */
function hourTicks(t0: number, t1: number, step: number): number[] {
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < t0) d.setHours(d.getHours() + 1);
  while (d.getHours() % step !== 0) d.setHours(d.getHours() + 1);
  const out: number[] = [];
  for (; d.getTime() <= t1 - 0.8 * HOUR; d.setHours(d.getHours() + step)) out.push(d.getTime());
  return out;
}

/** 精神（实线）和心情（虚线）曲线、变化原因竖线和小牌，下面三条决策泳道，共用一条时间轴和一根光标；图下一行读那一刻。 */
export function StateDecisionChart(p: StateDecisionChartProps) {
  const [box, width] = useWidth<HTMLDivElement>(720);
  const CH = useCurveHeight();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(320, width);
  const H = CT + CH + LG + LANES.length * LH + AX;
  const span = Math.max(1, p.t1 - p.t0);
  const x = (t: number) => L + ((t - p.t0) / span) * (W - L - R);
  const y = (v: number) => CT + (1 - (v - V_MIN) / (V_MAX - V_MIN)) * CH;
  const end = p.stoppedAt ?? p.t1;
  const pts = p.log.filter((q) => q.at >= p.t0 && q.at <= end);
  const path = (k: 'energy' | 'valence') => pts.map((q, i) => `${i ? 'L' : 'M'}${x(q.at).toFixed(1)} ${y(q[k]).toFixed(1)}`).join('');
  const causes = p.causes.filter((c) => c.at >= p.t0 && c.at <= end);
  const beats = p.beats.filter((b) => b.at >= p.t0 && b.at <= end);
  const cur = hover ?? p.pick;

  // Cause tags: the picked one first, then the largest moves, none overlapping another, inside the plot.
  const tagW = (c: StateCause) => shortName(c).length * 12 + 12;
  const tagAt = (c: StateCause): [number, number] => (x(c.at) + tagW(c) > W - R - 2 ? [x(c.at) - tagW(c), x(c.at)] : [x(c.at), x(c.at) + tagW(c)]);
  const tagged: StateCause[] = [];
  for (const c of [...causes].sort((a, b) => Number(b.at === p.pick) - Number(a.at === p.pick) || Math.abs(b.delta) - Math.abs(a.delta))) {
    const [a0, a1] = tagAt(c);
    if (tagged.length < TAGS && tagged.every((o) => { const [b0, b1] = tagAt(o); return a1 + 4 < b0 || b1 + 4 < a0; })) tagged.push(c);
  }

  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) * W) / (r.width || W);
    if (px < L) return setHover(null);
    setHover(Math.min(p.t1, p.t0 + ((px - L) / (W - L - R)) * span));
  };
  const click = (e: MouseEvent<SVGSVGElement>) => {
    const at = (e.target as Element).closest('[data-at]')?.getAttribute('data-at');
    if (at == null) return;
    setHover(null);
    p.onPick(Number(at));
  };
  // ←→ step through the decisions, as the trace timeline does.
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const at = p.pick ?? p.t1;
    const next = e.key === 'ArrowLeft' ? [...beats].reverse().find((b) => b.at < at) : beats.find((b) => b.at > at);
    if (!next) return;
    e.preventDefault();
    p.onPick(next.at);
  };

  const ly = CT + CH + LG;
  const grid: ReactNode[] = [];
  for (const v of [1, 0.5, 0, V_MIN]) {
    grid.push(
      <g key={`y${v}`}>
        <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? styles.axis : styles.grid} strokeDasharray={v === 0 ? undefined : '2 4'} />
        <text x={L - 8} y={y(v) + 4} textAnchor="end" className={styles.yl}>
          {v === 0 ? '0' : v.toFixed(1).replace('-', '−')}
        </text>
      </g>,
    );
  }
  for (const t of hourTicks(p.t0, p.t1, p.step)) {
    grid.push(
      <g key={`x${t}`}>
        <line x1={x(t)} x2={x(t)} y1={CT} y2={H - AX} className={styles.grid} />
        <text x={x(t)} y={H - 6} textAnchor="middle" className={styles.xl}>
          {formatClock(t)}
        </text>
      </g>,
    );
  }
  const last = pts.at(-1);

  return (
    <div className={styles.chart}>
      <div ref={box} className={styles.plot} role="group" tabIndex={0} aria-label={`${p.label}；←→ 换一个决策`} onKeyDown={key}>
        <svg role="img" aria-label={p.label} width={W} height={H} viewBox={`0 0 ${W} ${H}`} onMouseMove={move} onMouseLeave={() => setHover(null)} onClick={click}>
          <rect x={L} y={CT} width={W - L - R} height={CH} className={styles.frame} />
          {grid}
          <line x1={L} x2={W - R} y1={y(SLEEPY)} y2={y(SLEEPY)} className={styles.ref} />
          <text x={L + 6} y={y(SLEEPY) - 4} className={styles.refl}>
            困 {SLEEPY}
          </text>
          {causes.map((c) => (
            <line key={`c${c.at}${c.attr}`} x1={x(c.at)} x2={x(c.at)} y1={CT} y2={CT + CH} className={styles.cause} data-on={c.at === p.pick || undefined} />
          ))}
          {tagged.map((c) => {
            const [a0, a1] = tagAt(c);
            return (
              <g key={`t${c.at}${c.attr}`} data-at={c.at} className={styles.hit}>
                <rect x={a0} y={CT - 18} width={a1 - a0 + 1} height={17} className={styles.tag} />
                <text x={a0 + 6} y={CT - 5} className={styles.tagt}>
                  {shortName(c)}
                </text>
              </g>
            );
          })}
          {pts.length > 0 && (
            <>
              <path d={path('valence')} className={styles.s2} />
              <path d={path('energy')} className={styles.s1} />
              {last && <rect x={x(last.at) - 3} y={y(last.energy) - 3} width={6} height={6} className={styles.dot} />}
            </>
          )}
          {pts.length === 0 && p.noCurve && (
            <text x={L + (W - L - R) / 2} y={CT + CH / 2 + 4} textAnchor="middle" className={styles.note}>
              {p.noCurve}
            </text>
          )}
          {LANES.map((k, i) => {
            const yy = ly + i * LH;
            const items = beats.filter((b) => b.source === k);
            return (
              <g key={k}>
                <rect x={L} y={yy + 3} width={W - L - R} height={LH - 6} className={styles.lane} />
                <text x={L - 8} y={yy + LH / 2 + 4} textAnchor="end" className={styles.ll}>
                  {BEAT_SOURCE[k]} <tspan className={styles.n}>{items.length}</tspan>
                </text>
                {items.map((b) =>
                  b.at === p.pick ? (
                    <rect key={b.id} x={x(b.at) - 3} y={yy + 1} width={6} height={LH - 2} className={styles.picked} />
                  ) : (
                    <rect key={b.id} x={x(b.at) - 1} y={yy + 5} width={2.4} height={LH - 10} className={styles.tick} />
                  ),
                )}
                {items.map((b) => (
                  <rect key={`h${b.id}`} data-at={b.at} x={x(b.at) - 5} y={yy} width={10} height={LH} className={styles.hit} fill="transparent" />
                ))}
              </g>
            );
          })}
          {beats.length === 0 && p.noBeats && (
            <text x={L + (W - L - R) / 2} y={ly + (LANES.length * LH) / 2 + 4} textAnchor="middle" className={styles.note}>
              {p.noBeats}
            </text>
          )}
          {p.stoppedAt != null && (
            <>
              <defs>
                <pattern id="beh-hz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="1.2" height="6" className={styles.hz} />
                </pattern>
              </defs>
              <rect x={x(p.stoppedAt)} y={CT} width={Math.max(0, x(p.t1) - x(p.stoppedAt))} height={H - AX - CT} fill="url(#beh-hz)" />
              <text x={x(p.stoppedAt) - 6} y={CT + CH - 8} textAnchor="end" className={styles.note}>
                {formatClock(p.stoppedAt)} 断开，之后没有数据
              </text>
            </>
          )}
          <line x1={x(p.t1)} x2={x(p.t1)} y1={CT} y2={H - AX} className={styles.now} />
          <rect x={x(p.t1) - 40} y={H - AX + 2} width={40} height={16} className={styles.tag} />
          <text x={x(p.t1) - 20} y={H - AX + 14} textAnchor="middle" className={styles.nowt}>
            {formatClock(p.t1)}
          </text>
          {cur != null && cur >= p.t0 && (
            <>
              <line x1={x(cur)} x2={x(cur)} y1={CT - 2} y2={H - AX} className={styles.cur} />
              {valueAt(pts, cur, 'energy') != null && <rect x={x(cur) - 3} y={y(valueAt(pts, cur, 'energy')!) - 3} width={6} height={6} className={styles.curDot} />}
            </>
          )}
        </svg>
      </div>
      <PickLine at={cur} {...p} pts={pts} />
    </div>
  );
}

/** One line for the cursor: the time, the cause there, the decision in force and who made it, energy and mood then. */
function PickLine({ at, pts, causes, beats, t0, t1 }: StateDecisionChartProps & { at: number | null; pts: StatePoint[] }) {
  if (at == null || at < t0) return <div className={styles.pick} />;
  const near = (t1 - t0) / 500;
  const beat = [...beats].reverse().find((b) => b.at <= at + near);
  const cause = causes.find((c) => Math.abs(c.at - at) <= near);
  const e = valueAt(pts, at, 'energy');
  const v = valueAt(pts, at, 'valence');
  const parts: ReactNode[] = [];
  if (cause)
    parts.push(
      <Fragment key="c">
        <b>{causeName(cause)}</b>
        <span className={styles.m}>
          {attrName(cause)} {signed(cause.delta)}
        </span>
      </Fragment>,
    );
  if (beat)
    parts.push(
      <Fragment key="b">
        <span>
          选择「<b>{BEHAVIOR[beat.chosen] ?? beat.chosen}</b>」
        </span>
        <span className={styles.m}>
          {BEAT_SOURCE[beat.source]}
          {Math.abs(beat.at - at) > near && `（${formatClock(beat.at)} 起）`}
        </span>
      </Fragment>,
    );
  if (e != null && v != null)
    parts.push(
      <span key="v" className={`${styles.m} ${styles.then}`}>
        当时精神 <b className={styles.num}>{e.toFixed(2)}</b>，心情 <b className={styles.num}>{signed(v)}</b>
      </span>,
    );
  return (
    <div className={styles.pick} aria-live="polite">
      <span className={styles.t}>{formatClock(at)}</span>
      {parts.map((x, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={styles.dv} />}
          {x}
        </Fragment>
      ))}
    </div>
  );
}
