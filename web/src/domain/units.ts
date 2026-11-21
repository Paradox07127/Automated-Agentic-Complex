// The only place wire times become epoch ms and back. agentd sends epoch seconds (float) or ISO with an offset.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const secToMs = (s: number): number => Math.round(s * 1000);

export const secToMsOrNull = (s: number | null | undefined): number | null => (s == null ? null : secToMs(s));

export function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`not an ISO time: ${iso}`);
  return ms;
}

export const isoToMsOrNull = (iso: string | null | undefined): number | null => (iso == null ? null : isoToMs(iso));

/** Request value for fields agentd reads as epoch seconds (quiet `until`, `?since=`). */
export const msToEpochSec = (ms: number): number => Math.floor(ms / 1000);

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** Local time with offset and milliseconds, as server.py `_iso` writes it (`/trace/turns?since=`). */
export function isoWithOffset(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}
