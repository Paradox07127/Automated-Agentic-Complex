// The fake bridge's `GET /trace/events`: the 事件线 demo stretch before the fixtures' now, filtered and paged as agentd does.
import { isoToMs } from '../../domain';
import { NOW } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/types';
import { lanesDemo } from '../../pages/trace/lanesDemo';
import type { TraceEvent, TraceEventsPage } from '../traceEvents';

const PAGE_MAX = 200;
const ZONED = /([+-]\d{2}:\d{2}|Z)$/;
const invalid = { status: 400, body: { error: 'invalid_query' } };

/** The demo stretch as the route answers it. */
export function demoTraceEvents(now: number): TraceEvent[] {
  return lanesDemo(now).map((e, i) => ({
    v: 1, turn_id: null, turn_generation: null, span_id: i.toString(16).padStart(16, '0'), parent_span_id: null,
    producer_epoch: 1, seq: i + 1, t_mono_ms: i, ...e,
  }));
}

export const traceEventRoutes: MockRoute[] = [
  {
    method: 'GET',
    path: '/trace/events',
    handler: ({ query }) => {
      const [since, until, kinds, cursor] = ['since', 'until', 'kinds', 'cursor'].map((k) => query.get(k));
      const limit = Number(query.get('limit') ?? PAGE_MAX);
      if ([since, until].some((t) => t != null && !ZONED.test(t)) || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) return invalid;
      if (kinds === '' || (cursor != null && !/^\d+$/.test(cursor))) return invalid;
      const want = kinds == null ? null : new Set(kinds.split(','));
      const [t0, t1] = [since == null ? -Infinity : isoToMs(since), until == null ? Infinity : isoToMs(until)];
      const all = demoTraceEvents(NOW).filter((e) => {
        const t = isoToMs(e.t_wall);
        return t >= t0 && t <= t1 && (want == null || want.has(e.kind));
      });
      const from = cursor == null ? 0 : Number(cursor);
      const body: TraceEventsPage = { events: all.slice(from, from + limit), cursor: from + limit < all.length ? String(from + limit) : null };
      return { status: 200, body };
    },
  },
];
