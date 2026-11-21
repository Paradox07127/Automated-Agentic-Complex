// Live readouts keep one decimal (ms) or none (fps), so their text width stays put between updates.

const missing = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v);

/** `6.1 ms`; `—` without a value. */
export function msReadout(v: number | null | undefined): string {
  return missing(v) ? '—' : `${v.toFixed(1)} ms`;
}

/** `60`; `—` without a value. */
export function fpsReadout(v: number | null | undefined): string {
  return missing(v) ? '—' : String(Math.round(v));
}
