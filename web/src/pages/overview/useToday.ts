// 今天 reads on top of useOverview: the work memory (L1 / L2 / L3) first, today's own reads when a route fails or
// returns nothing.
import { useQuery } from '@tanstack/react-query';
import { get } from '../../bridge/agentd';
import type { MemoryDaysResponse, MemorySessionsResponse } from '../../bridge/agentd-routes.generated';
import type { DemoState } from '../../shell/demo';
import { usePlugins } from '../../shell/plugins';
import type { RegionSource } from '../../ui';
import { clock, dayOf, readDay } from './load';
import { loadBrief } from './loadBrief';
import { joined } from './regions';
import { dayLineFromL3, summaryText, timelineFromDay, timelineFromL1, type DayLine, type TimelineEntry, type WireDaySummary, type WireSessionSummary } from './today';
import type { useOverview } from './useOverview';

export { resetOnAccessChange } from '../../data/accessReset';

type Overview = ReturnType<typeof useOverview>;

// agentd filters these reads by the current consent, so they are read again on each mount.
const once = { retry: false } as const;

/** Noon of `day`: the reads that take a clock pick their day from it. */
function noonOf(day: string): number {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

/** A query's rows; null when it failed or returned none (the fallback shows), undefined while it is read. */
function rowsOf<T>(q: { isSuccess: boolean; isError: boolean; data?: T[] | undefined }, off: boolean): T[] | null | undefined {
  if (off || q.isError) return null;
  if (!q.isSuccess) return undefined;
  return q.data?.length ? q.data : null;
}

export interface TodayReads {
  day: string;
  isToday: boolean;
  timeline: RegionSource<TimelineEntry[]>;
  summaries: WireSessionSummary[];
  /** Undefined while it is read. */
  dayLine: DayLine | null | undefined;
  daySummary: WireDaySummary | null;
}

/** `day` is the `day=` URL value; anything but YYYY-MM-DD reads today. */
export function useToday(ov: Overview, demo: string | null, state: DemoState | null, dayParam: string | null, now: number): TodayReads {
  const plugins = usePlugins();
  const today = dayOf(clock());
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : today;
  const isToday = day === today;
  const reads = state !== 'loading';
  // `state=empty` has no work anywhere, the work memory included.
  const off = state === 'empty';
  const fake = !window.agenticComplex && demo ? `&demo=${encodeURIComponent(demo)}` : '';
  const enabled = reads && !off;

  const l1 = useQuery({
    queryKey: ['today', demo, 'l1', day],
    queryFn: async () => (await get<MemorySessionsResponse>(`/memory/sessions?day=${day}${fake}`)).sessions,
    enabled,
    ...once,
  });
  const l3 = useQuery({
    queryKey: ['today', demo, 'l3', day],
    queryFn: async () => (await get<MemoryDaysResponse>(`/memory/days?from=${day}&to=${day}${fake}`)).days,
    enabled,
    ...once,
  });
  const l1Rows = rowsOf(l1, off);
  const otherDay = reads && !isToday;
  const ob = useQuery({ queryKey: ['today', demo, 'brief', day], queryFn: () => loadBrief(noonOf(day)), enabled: otherDay, ...once });
  const os = useQuery({ queryKey: ['today', demo, 'segments', day], queryFn: () => readDay(demo, noonOf(day)), enabled: otherDay, ...once });

  const briefRead = isToday ? ov.reads.brief : ob;
  const segRead = isToday ? ov.reads.day : os;
  const brief = isToday ? ov.brief : ob.data;
  const segs = isToday && ov.data.day.segments.length === 0 ? null : (segRead.data ?? null);
  const j = joined([briefRead], [segRead]);
  const localRows = j.data && brief ? timelineFromDay(brief.episodes ?? [], segs, brief.convs ?? [], ov.data.sessions, now) : undefined;
  const summaryRows = l1Rows ? timelineFromL1(l1Rows) : [];
  const identity = (row: TimelineEntry) => JSON.stringify([row.source, row.t0, row.t1, row.title]);
  const summarized = new Set(summaryRows.map(identity));
  const merged = l1Rows ? [...summaryRows, ...(localRows ?? []).filter((r) =>
    r.origin !== 'segment' || !summarized.has(identity(r))
  )].sort((a, b) => b.t0 - a.t0) : localRows;
  const timeline: RegionSource<TimelineEntry[]> = {
    ...j, status: l1Rows || localRows ? 'success' : j.status, data: merged,
    refetch: () => Promise.all([j.refetch?.(), l1.refetch()]),
  };

  const days = rowsOf(l3, off);
  const l3Line = days ? dayLineFromL3(days, day) : days;
  const text = ov.q.data ? summaryText(ov.data, now, plugins.coding_sessions) : null;
  const local: DayLine | null | undefined = !isToday ? null : !ov.q.data ? undefined : text == null ? null : { text, origin: 'local', at: null };
  return {
    day,
    isToday,
    timeline,
    summaries: l1Rows ?? [],
    dayLine: l3Line === undefined ? undefined : (l3Line ?? local),
    daySummary: days?.find((d) => d.date === day && d.period === 'day') ?? null,
  };
}
