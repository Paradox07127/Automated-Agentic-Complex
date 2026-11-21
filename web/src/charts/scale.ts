// Pure scale, tick and threshold helpers shared by the charts.
import { formatClock, formatElapsed, formatMs } from '../domain';

export const MAX_TICKS = 6;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Share of `value` in `[0, max]`, clamped to 0..1; 0 when max is not positive. */
export function fraction(value: number, max: number): number {
  return max > 0 && Number.isFinite(value) ? clamp(value / max, 0, 1) : 0;
}

/** Smallest 1/2/5 × 10^k step that puts at most `maxTicks` ticks on a span. */
export function niceStep(span: number, maxTicks = MAX_TICKS): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  let k = Math.floor(Math.log10(span / maxTicks)) - 1;
  for (;;) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** k;
      if (Math.floor(span / step + 1e-9) + 1 <= maxTicks) return step;
    }
    k += 1;
  }
}

function roundTo(v: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v.toFixed(Math.min(digits, 12)));
}

/** Ticks at multiples of a nice step inside `[min, max]` (at most `maxTicks`). */
export function niceTicks(min: number, max: number, maxTicks = MAX_TICKS): number[] {
  if (!(max > min)) return [min];
  const step = niceStep(max - min, maxTicks);
  const out: number[] = [];
  for (let t = Math.ceil(min / step - 1e-9) * step; t <= max + step * 1e-9; t += step) out.push(roundTo(t, step));
  return out.slice(0, maxTicks);
}

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
/** Time steps: 1/2/5 multiples of ms, then clock-friendly second, minute, hour and day steps. */
const TIME_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, S, 2 * S, 5 * S, 10 * S, 20 * S, 30 * S, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 20 * MIN, 30 * MIN, H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H];

export function timeStep(span: number, maxTicks = MAX_TICKS): number {
  return TIME_STEPS.find((s) => Math.floor(span / s + 1e-9) + 1 <= maxTicks) ?? Math.ceil(span / (maxTicks - 1));
}

/** Local-time ticks for an absolute axis (epoch ms), aligned to local midnight. */
export function timeTicks(start: number, end: number, maxTicks = MAX_TICKS): number[] {
  if (!(end > start)) return [start];
  const step = timeStep(end - start, maxTicks);
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  const base = day.getTime();
  const out: number[] = [];
  for (let t = base + Math.ceil((start - base) / step) * step; t <= end; t += step) out.push(t);
  return out.slice(0, maxTicks);
}

/** Axis label for an absolute time: `HH:mm`, `HH:mm:ss` below one-minute steps, `M/D` for day steps. */
export function clockTickLabel(t: number, step: number): string {
  if (step >= 24 * H) {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return formatClock(t, { seconds: step < MIN });
}

/** Ticks for a relative axis starting at 0 (ms offsets). */
export function offsetTicks(totalMs: number, maxTicks = MAX_TICKS): number[] {
  if (!(totalMs > 0)) return [0];
  const step = timeStep(totalMs, maxTicks);
  const out: number[] = [];
  for (let t = 0; t <= totalMs; t += step) out.push(t);
  return out.slice(0, maxTicks);
}

/** Relative offset label: `ms`/`s` under one minute, `mm:ss` above. */
export function offsetTickLabel(ms: number, totalMs: number): string {
  return totalMs < MIN ? formatMs(ms) : formatElapsed(ms);
}

/** Linear map from a domain to 0..1 (clamped). */
export function linear(lo: number, hi: number): (v: number) => number {
  const span = hi - lo;
  return (v) => (span === 0 ? 0.5 : clamp((v - lo) / span, 0, 1));
}

export const LOG_TICKS_MS = [100, 1000, 10_000, 60_000];

/** Log map for durations (100 ms … 1 min) to 0..1. */
export function logPos(ms: number): number {
  const lo = Math.log10(100);
  const hi = Math.log10(60_000);
  return (Math.log10(clamp(ms, 100, 60_000)) - lo) / (hi - lo);
}

export function logTickLabel(ms: number): string {
  return ms >= 60_000 ? '1 min' : formatMs(ms);
}

export type UsageLevel = 'ok' | 'high' | 'over';

/** Threshold colour of a usage meter: < 70 % ok, 70–90 % high (▲), ≥ 90 % over (■). */
export function usageLevel(value: number, max: number): UsageLevel {
  const p = max > 0 ? value / max : 0;
  return p >= 0.9 ? 'over' : p >= 0.7 ? 'high' : 'ok';
}

/** Words for a usage meter: the ≥ 90 % band says 接近上限 while still within the limit, 超限 only above it. */
export function usageText(value: number, max: number): string {
  const level = usageLevel(value, max);
  if (level === 'over') return max > 0 && value > max ? '超限' : '接近上限';
  return level === 'high' ? '偏高' : '正常';
}

/** SVG path through the points; null values break the line. `step` holds each value until the next point. */
export function linePath(values: ReadonlyArray<number | null>, x: (i: number) => number, y: (v: number) => number, step = false): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    if (pen && step) d += `H${x(i).toFixed(1)}V${y(v).toFixed(1)}`;
    else d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Index of the last non-null value, or -1. */
export function lastIndex(values: ReadonlyArray<number | null>): number {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] != null) return i;
  return -1;
}
