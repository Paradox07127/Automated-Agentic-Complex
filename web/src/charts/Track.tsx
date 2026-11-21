import { Fragment, type ReactNode } from 'react';
import { cx, hm, rulerTicks } from './v3';
import t from './Track.module.css';

/** Approximate pixel width of the 「现在」 flag (`hh:mm` plus padding). */
export const flagWidth = (now: number) => hm(now).length * 6.8 + 8;

/**
 * Tick labels the ruler draws: labelled long ticks inside the view, minus those that would touch the now flag
 * (4 px on each side; the flag sits right of the line, or left of it in the last 10 %).
 */
export function rulerLabels(v0: number, v1: number, px: number, now?: number): number[] {
  const r = rulerTicks(v0, v1, px);
  const P = (x: number) => ((x - v0) / (v1 - v0 || 1)) * 100;
  const X = (x: number) => (P(x) / 100) * px;
  const inView = now != null && now >= v0 && now <= v1;
  const fw = inView ? flagWidth(now) : 0;
  const fx = inView ? X(now) : 0;
  const [f0, f1] = inView && P(now) > 90 ? [fx - fw - 4, fx + 4] : [fx - 4, fx + fw + 4];
  const clear = (x: number) => {
    if (!inView) return true;
    const a = X(x) + 3;
    const b = a + r.fmt(x).length * 6.6;
    return b < f0 || a > f1;
  };
  return r.longs.filter((x) => r.lab(x) && P(x) < 97 && clear(x));
}

/** Ruler on top of a track: long and short ticks, labels clear of the now flag, optional ▼ marks. */
export function TrackRuler({ v0, v1, px, now, marks }: { v0: number; v1: number; px: number; now?: number; marks?: ReactNode }) {
  const r = rulerTicks(v0, v1, px);
  const P = (x: number) => ((x - v0) / (v1 - v0 || 1)) * 100;
  const shown = new Set(rulerLabels(v0, v1, px, now));
  return (
    <span className={t.rul} data-ruler="">
      {r.shorts.map((x) => (
        <i key={`s${x}`} className={t.s} style={{ left: `${P(x)}%` }} aria-hidden="true" />
      ))}
      {r.longs.map((x) => (
        <Fragment key={`l${x}`}>
          <i className={t.l} style={{ left: `${P(x)}%` }} aria-hidden="true" />
          {shown.has(x) && (
            <b style={{ left: `${P(x)}%` }} aria-hidden="true" data-tick={x}>
              {r.fmt(x)}
            </b>
          )}
        </Fragment>
      ))}
      {marks}
    </span>
  );
}

/** Current-time line with its time flag; `f` is the 0..1 position across the track column. */
export function NowFlag({ f, at }: { f: number; at: number }) {
  return (
    <span className={t.nowl} style={{ left: `calc(var(--lw) + (100% - var(--lw)) * ${f})` }} aria-hidden="true" data-now-flag="">
      <b className={cx(t.flag, f > 0.9 && t.right)}>{hm(at)}</b>
    </span>
  );
}

export { t as trackStyles };
