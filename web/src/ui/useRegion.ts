import { useEffect, useRef, useState } from 'react';
import { usePageIssues } from './PageIssues';

/** What a region reads: a react-query result fits as is. */
export interface RegionSource<T> {
  status: 'pending' | 'error' | 'success';
  data: T | undefined;
  error?: unknown;
  isFetching?: boolean;
  /** When the data shown was read (epoch ms). */
  dataUpdatedAt?: number;
  refetch?: () => unknown;
  /** When the first load began (epoch ms); defaults to when the region first saw it. */
  startedAt?: number;
}

/**
 * The region placeholder states. `wait`: the first 300 ms of a first load, nothing drawn yet;
 * `stale`: a read failed but older data is shown; `offline`: the page says agentd is gone, data is the last read.
 */
export type RegionState = 'wait' | 'loading' | 'slow' | 'ok' | 'refreshing' | 'empty' | 'stale' | 'offline' | 'failed';

export interface RegionView<T> {
  state: RegionState;
  data: T | undefined;
  /** Why the read failed, as a sentence. */
  reason: string;
  /** Time of the data shown (epoch ms). */
  at: number | undefined;
  /** Whole seconds a first load has waited. */
  waited: number;
}

export const SKELETON_AFTER_MS = 300;
export const SLOW_AFTER_MS = 8000;

const emptyList = (d: unknown) => Array.isArray(d) && d.length === 0;

/** Error text for the user: an Error's message (the data layer writes it in Chinese) or a plain string. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '原因不明';
}

/** Maps a query result to one RegionState; re-renders at 300 ms, at 8 s and every second after while a first load waits. */
export function useRegion<T>(q: RegionSource<T>, isEmpty: (d: T) => boolean = emptyList): RegionView<T> {
  const offline = usePageIssues()?.offline ?? false;
  const first = q.data === undefined && q.status !== 'error';
  const start = useRef<number | null>(null);
  if (!first) start.current = null;
  else if (start.current == null) start.current = q.startedAt ?? Date.now();
  const t0 = start.current;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (t0 == null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const e = t - t0;
      timer = setTimeout(tick, e < SKELETON_AFTER_MS ? SKELETON_AFTER_MS - e : e < SLOW_AFTER_MS ? SLOW_AFTER_MS - e : 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [t0]);

  const waitedMs = t0 == null ? 0 : Math.max(0, now - t0);
  const at = q.dataUpdatedAt || undefined;
  const view = (state: RegionState): RegionView<T> => ({ state, data: q.data, reason: reasonOf(q.error), at, waited: Math.floor(waitedMs / 1000) });
  if (q.data === undefined) {
    if (q.status === 'error') return view('failed');
    return view(waitedMs < SKELETON_AFTER_MS ? 'wait' : waitedMs < SLOW_AFTER_MS ? 'loading' : 'slow');
  }
  if (offline) return view('offline');
  if (q.status === 'error') return view('stale');
  if (isEmpty(q.data)) return view('empty');
  return view(q.isFetching ? 'refreshing' : 'ok');
}
