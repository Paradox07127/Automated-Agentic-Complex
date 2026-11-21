// 观察页的读取：/diag/state、/task-understanding、/episodes、/attention/*、/blacklist、/memory；demo 只在这里裁剪数据。
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AgentdCallError, get } from '../../bridge/agentd';
import { fromAttention, fromBrowser, fromEpisode, type AttentionSummary, type AppTime, type BrowserNow, type Episode, type WireAttention, type WireBrowser, type WireEpisode } from '../../domain';
import type { DemoFlags } from '../../shell/demo';
import type { RegionSource } from '../../ui';
import {
  dayStart,
  errorText,
  isMock,
  KEY,
  localDate,
  nowOf,
  pageNow,
  pausedUntilOf,
  readDiag,
  readTask,
  rulesOf,
  taskGuessOf,
  type ExRule,
  type NowData,
  type TaskGuess,
  type WireBlacklist,
  type WireFactRef,
} from './data';
import { demo as slot } from './demoSlot';
import type { ObsSegment, ObsShot } from './model';

/** Demos that also draw the blocks waiting on per-span attention events. */
const B11_DEMOS = new Set(['full', 'paused']);

/** What the observation events would give: foreground spans, screenshot times, refused requests and the pause span. */
export interface SpanData {
  segs: ObsSegment[];
  shots: ObsShot[];
  blocked: Array<{ t: number; why: string }>;
  pause: { from: number; until: number } | null;
}

export interface ObserveData {
  now: number;
  day: string;
  today: boolean;
  start: number;
  off: boolean;
  /** What each section's Region reads; forced by `state=`, else the queries. */
  src: {
    now: RegionSource<unknown>;
    eps: RegionSource<unknown>;
    time: RegionSource<unknown>;
    web: RegionSource<unknown>;
    ex: RegionSource<unknown>;
  };
  loading: boolean;
  /** A read failed because agentd is gone; the page banner says so. */
  disconnected: boolean;
  /** Read and nothing recorded today: no episodes, no app or site time. */
  empty: boolean;
  pausedUntil: number | null;
  nowData: NowData | null;
  guess: TaskGuess | null;
  episodes: Episode[];
  apps: AppTime[];
  hosts: AppTime[];
  summary: AttentionSummary | null;
  browser: BrowserNow | null;
  rules: ExRule[];
  facts: WireFactRef[];
  /** Null unless an observation-events demo is open on the fake bridge. */
  spans: SpanData | null;
  sparse: boolean;
}

function spansOf(demo: string | null, sparse: boolean): SpanData | null {
  const b11 = slot.b11;
  if (!isMock() || !demo || !B11_DEMOS.has(demo) || !b11) return null;
  const pause = demo === 'paused' ? b11.pause : null;
  const end = pause?.from ?? Infinity;
  const segs = b11.segments.filter((s) => s.t0 < end).map((s) => (s.t1 > end ? { ...s, t1: end } : s));
  const src = sparse ? segs.slice(0, 5) : segs;
  return {
    segs: src,
    shots: b11.shots(b11.segments, sparse ? 5 : 37).filter((s) => s.t < end),
    blocked: sparse ? [] : b11.blocked.filter((b) => b.t < end),
    pause,
  };
}

/** One Region over two reads: data once both have answered, the first error, the older read time. */
function both(a: RegionSource<unknown>, b: RegionSource<unknown>): RegionSource<unknown> {
  const error = a.error ?? b.error;
  return {
    status: error ? 'error' : a.status === 'pending' || b.status === 'pending' ? 'pending' : 'success',
    data: a.data !== undefined && b.data !== undefined ? true : undefined,
    error,
    isFetching: a.isFetching || b.isFetching,
    dataUpdatedAt: Math.min(a.dataUpdatedAt ?? 0, b.dataUpdatedAt ?? 0) || undefined,
    refetch: () => Promise.all([a.refetch?.(), b.refetch?.()]),
  };
}

export function useObserve(flags: DemoFlags, day: string, pausedOverride: number | null | undefined): ObserveData {
  const { demo, state } = flags;
  const sparse = demo === 'sparse';
  const clock = pageNow();
  const diag = useQuery({ queryKey: KEY.diag, queryFn: readDiag });
  const off = demo === 'off' || diag.data?.observation?.off === true;
  const on = !off;
  const task = useQuery({ queryKey: KEY.task, queryFn: readTask, enabled: on });
  const eps = useQuery({
    queryKey: [...KEY.episodes, day],
    queryFn: () => get<{ enabled: boolean; episodes: WireEpisode[] }>(`/episodes?date=${day}`),
    enabled: on,
  });
  const att = useQuery({
    queryKey: KEY.attention,
    queryFn: async () => fromAttention(await get<WireAttention>('/attention/summary?by=app'), await get<WireAttention>('/attention/summary?by=domain')),
    enabled: on,
  });
  const browser = useQuery({
    queryKey: KEY.browser,
    queryFn: async () => fromBrowser(await get<WireBrowser>('/attention/browser')),
    enabled: on,
  });
  const black = useQuery({
    queryKey: KEY.blacklist,
    // A copy: the fake bridge hands back the one list it mutates, which would compare equal to the cached one.
    queryFn: async () => structuredClone(await get<WireBlacklist>('/blacklist')),
    enabled: on,
  });
  const mem = useQuery({
    queryKey: KEY.memory,
    queryFn: () => get<{ facts: WireFactRef[] }>('/memory'),
    enabled: on,
  });

  const empty = state === 'empty';
  const offline = new AgentdCallError(0, 'offline', undefined, null, 'offline');
  const sourceOf = (q: UseQueryResult<unknown, Error>): RegionSource<unknown> => {
    if (state === 'loading') return { status: 'pending', data: undefined, isFetching: true };
    const error = state === 'error' ? offline : q.error;
    return {
      status: error ? 'error' : q.status,
      data: q.data,
      error: error && new Error(errorText(error)),
      isFetching: q.isFetching,
      // The fake bridge answers at wall-clock time; its pages run on the fixture clock.
      dataUpdatedAt: (!isMock() && q.dataUpdatedAt) || clock,
      refetch: q.refetch,
    };
  };

  let episodes = empty ? [] : (eps.data?.episodes ?? []).map(fromEpisode);
  let nowData = empty ? null : nowOf(diag.data);
  let guess = empty ? null : taskGuessOf(task.data);
  let hosts = empty ? [] : (att.data?.hosts ?? []);
  let apps = empty ? [] : (att.data?.apps ?? []);
  let browserNow = empty ? null : (browser.data ?? null);
  const spans = empty ? null : spansOf(demo, sparse);
  if (sparse) {
    episodes = episodes.slice(0, 2);
    hosts = hosts.slice(0, 1);
    apps = apps.slice(0, 2);
    browserNow = browserNow && { ...browserNow, current: null };
    guess = null;
    nowData = nowData && {
      ...nowData,
      focus: null,
      activity: null,
      items: [],
      recent: nowData.recent.slice(-1),
    };
  }
  const pause = spans?.pause;
  if (pause) episodes = episodes.filter((e) => e.start < pause.from).map((e) => (e.end && e.end > pause.from ? { ...e, end: pause.from } : e));

  const real = pausedUntilOf(diag.data);
  const pausedUntil = pausedOverride !== undefined ? pausedOverride : spans?.pause ? spans.pause.until : real;
  return {
    now: clock,
    day,
    today: day === localDate(clock),
    start: dayStart(day),
    off,
    src: {
      now: sourceOf(diag),
      eps: sourceOf(eps),
      time: sourceOf(att),
      web: both(sourceOf(att), sourceOf(browser)),
      ex: sourceOf(black),
    },
    loading: state === 'loading' || (state !== 'error' && diag.isPending && !diag.error),
    disconnected: state === 'error' || (on && [diag, eps, att, browser, black].some((q) => q.error instanceof AgentdCallError && q.error.code === 'offline')),
    empty: (empty || (state == null && eps.isSuccess && att.isSuccess)) && episodes.length === 0 && apps.length === 0 && hosts.length === 0,
    pausedUntil,
    nowData,
    guess,
    episodes,
    apps,
    hosts,
    summary: empty ? null : (att.data?.summary ?? null),
    browser: browserNow,
    rules: empty ? [] : rulesOf(black.data),
    facts: mem.data?.facts ?? [],
    spans,
    sparse,
  };
}
