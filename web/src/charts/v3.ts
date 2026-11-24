// Shared helpers of the charts and time tracks: colours, number and time formats, ticks.
import { formatClock, formatDuration } from '../domain';
import { niceTicks } from './scale';

export const INK = ['var(--v3-ink-1)', 'var(--v3-ink-2)', 'var(--v3-ink-3)'] as const;
/** Fill levels of areas and bars: ink, secondary ink, chip, hatch. */
export const FILL = ['var(--v3-ink-1)', 'var(--v3-ink-2)', 'var(--v3-chip)', 'var(--v3-hatch)'] as const;
export const EMPH = 'var(--v3-emph)';
/** The selected item: trace in both themes. */
export const SEL = 'var(--v3-sel)';
export const CAT: Record<string, string> = { 1: 'var(--v3-cat-1)', 2: 'var(--v3-cat-2)', 3: 'var(--v3-cat-3)', other: 'var(--v3-cat-other)' };

/** Maps the documented colour tokens (`var(--ef-cat-1)`, `var(--ef-ink-s2)`, `var(--ef-emph)`) onto the palette; a failure never paints red. */
export function paint(c: string): string;
export function paint(c: string | undefined): string | undefined;
export function paint(c: string | undefined) {
  return c?.replace(/var\(--ef-(?:ink-s(\d)|cat-(\d|other)|emph)\)/g, (_m, ink?: string, cat?: string) => (ink ? `var(--v3-ink-${ink})` : cat ? `var(--v3-cat-${cat})` : EMPH)).replace('var(--ef-danger)', 'var(--ef-state-failed)');
}

/**
 * Series without a colour take the ink ramp in order (`fill` for areas and bars); the `emph` one takes the emphasis colour.
 * The emphasis is ink on paper, so while something is emphasised (`lighter`) the ramp starts one step lighter.
 */
export function seriesColors(list: ReadonlyArray<{ id?: string | number; color?: string }>, emph?: string | number | null, fill = false, lighter = list.some((s) => s.id != null && s.id === emph)): string[] {
  const ramp: readonly string[] = fill ? FILL : INK;
  let k = lighter ? 1 : 0;
  return list.map((s) => (s.id != null && s.id === emph ? EMPH : paint(s.color) ?? ramp[Math.min(k++, ramp.length - 1)]!));
}

/** SVG paint of a fill level: the hatch level becomes the pattern `hatchId`; chip and hatch get a hairline edge so they read on the plot. */
export function svgFill(c: string | undefined, hatchId: string): { fill?: string; stroke?: string } {
  const hatch = c === FILL[3] || c === CAT.other;
  return { fill: hatch ? `url(#${hatchId})` : c, stroke: hatch || c === FILL[2] || c === CAT[3] ? 'var(--ef-line-strong)' : undefined };
}

export const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(' ');
export const sum = (a: ReadonlyArray<number | null | undefined>) => a.reduce<number>((x, y) => x + (y ?? 0), 0);
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const fmtN = (v: number | null | undefined) => (v == null ? '—' : Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2));
export const hm = (t: number) => formatClock(t);
export const hms = (t: number) => formatClock(t, { seconds: true });
export const dur = (ms: number) => formatDuration(ms);
export const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Props that make a drawn mark a keyboard button: focusable, named, pressed by click, Enter or Space. */
export const pressable = (label: string, press: () => void) => ({
  role: 'button' as const,
  tabIndex: 0,
  'aria-label': label,
  onClick: press,
  onKeyDown: (e: { key: string; preventDefault: () => void }) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    press();
  },
});
/** Chinese SVG text is set at 12 px, numbers at 11 px. */
export const isZh = (s: unknown) => /[^\x00-\x7F]/.test(String(s));

/** Ticks with at most `max` intervals (1/2/5 × 10^k). */
export const ticks = (lo: number, hi: number, max = 4) => niceTicks(lo, hi, max + 1);

/** Smallest tick at or above `v`. */
export function niceMax(v: number): number {
  const t = ticks(0, v || 1, 4);
  const last = t[t.length - 1] ?? 1;
  return last >= v ? last : last + ((t[1] ?? 1) - (t[0] ?? 0));
}

const tzo = (t: number) => new Date(t).getTimezoneOffset() * 60e3;

/** Times in `[t0, t1]` on multiples of `step`, aligned to local time. */
export function align(t0: number, t1: number, step: number): number[] {
  const z = tzo(t0);
  const out: number[] = [];
  for (let t = Math.ceil((t0 - z) / step) * step + z; t <= t1; t += step) out.push(t);
  return out;
}

export interface Ruler {
  longs: number[];
  shorts: number[];
  /** Long ticks that get a label: only those far enough apart. */
  lab: (t: number) => boolean;
  fmt: (t: number) => string;
}

/** Ruler ticks for `px` pixels: hours with 15-minute shorts, densifying to 15/5, 5/1 and 1-minute/10-second steps as the view zooms in. */
export function rulerTicks(t0: number, t1: number, px: number): Ruler {
  const ppm = Math.max(1e-6, px / ((t1 - t0) / 60e3));
  const [lg, sh] = ppm < 4 ? [60, 15] : ppm < 16 ? [15, 5] : ppm < 60 ? [5, 1] : [1, 1 / 6];
  const longs = align(t0, t1, lg * 60e3);
  const z = tzo(t0);
  const shorts = sh * ppm >= 5 ? align(t0, t1, sh * 60e3).filter((t) => Math.round(t - z) % (lg * 60e3) !== 0) : [];
  const every = [1, 2, 3, 4, 6, 12, 24].find((k) => k * lg * ppm >= 52) ?? 24;
  return { longs, shorts, lab: (t) => Math.round((t - z) / (lg * 60e3)) % every === 0, fmt: sh < 1 ? hms : hm };
}

/** Reduced motion: system setting, the app's `still` screenshot mode, or the reduce-motion switch. */
export function calm(): boolean {
  if (typeof window === 'undefined') return true;
  const root = document.documentElement;
  return root.classList.contains('still') || root.hasAttribute('data-reduce-motion') || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}
