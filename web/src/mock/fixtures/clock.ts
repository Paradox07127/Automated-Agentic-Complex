// The fixtures live on 2026-10-29 with "now" frozen at 14:32:10 local time (the prototype's 14:32 plus the newest trace turn).
import { isoWithOffset } from '../../domain/units';

export { SECOND, MINUTE, HOUR, DAY } from '../../domain/units';

/** Local time on the fixture day (month is 0-based: 9 = October). */
export function at(h: number, m: number, s = 0): number {
  return new Date(2026, 9, 29, h, m, s).getTime();
}

/** The same local time as epoch seconds, the unit agentd's float timestamps use. */
export function atS(h: number, m: number, s = 0): number {
  return at(h, m, s) / 1000;
}

/** The same local time as agentd's ISO (`_iso`: local offset, milliseconds). */
export function isoAt(h: number, m: number, s = 0): string {
  return isoWithOffset(at(h, m, s));
}

export const NOW = at(14, 32, 10);

/** Deterministic PRNG (same generator as the prototype) so every run of the fixtures is identical. */
export function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
