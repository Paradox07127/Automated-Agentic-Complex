// Times on the 编排 page: the idle axis of the loop map (square-root, so 20 s and 10 m both fit) and a chain's running time.
import type { GraphSeg } from './graph';

export const AXIS_MAX = 600;
export const TICKS = [0, 30, 60, 120, 240, 480, 600];

/** Where `s` seconds idle sits on the axis, 0–1. */
export const along = (s: number) => Math.sqrt(Math.min(AXIS_MAX, Math.max(0, s)) / AXIS_MAX);

const r1 = (x: number) => String(Math.round(x * 10) / 10);

export const tickText = (s: number) => (s === 0 ? '0' : s < 60 ? `${s} s` : `${r1(s / 60)} m`);

/** 20–40 s, 2–4 m, 50 s–2 m. */
export function rangeText([a, b]: [number, number]): string {
  if (b <= 60) return a === b ? `${r1(a)} s` : `${r1(a)}–${r1(b)} s`;
  if (a >= 60) return a === b ? `${r1(a / 60)} m` : `${r1(a / 60)}–${r1(b / 60)} m`;
  return `${tickText(a)}–${tickText(b)}`;
}

/** How long a segment plays: a held loop its hold (the middle of its range), else its length. */
export function segTime(seg: GraphSeg): number {
  const r = seg.hold_range_s;
  if (seg.loop && r) return (r[0] + r[1]) / 2;
  return seg.length_s ?? 0;
}

export const secText = (s: number) => `${r1(s)} s`;
