// `GET /trace/events` (C6, T1): every trace's events in a time range, in agentd's stored order, a page at a time.
import { get } from './agentd';

/** A T1 event; its text values are `{len, head}` only. */
export interface TraceEvent {
  v: number;
  event_id: string;
  trace_id: string;
  turn_id: string | null;
  turn_generation: number | null;
  span_id: string;
  parent_span_id: string | null;
  causation_id: string | null;
  producer: string;
  producer_epoch: number;
  seq: number;
  kind: string;
  t_wall: string;
  t_mono_ms: number;
  t_recv_wall?: string;
  duration_ms?: number;
  status: string;
  attrs: Record<string, unknown>;
}

/** `cursor` reads the next page with the same query; null on the last page. */
export interface TraceEventsPage {
  events: TraceEvent[];
  cursor: string | null;
}

export interface TraceEventsQuery {
  /** ISO 8601 with a zone; `since` ≤ `t_wall` ≤ `until`, either end open when left out. */
  since?: string;
  until?: string;
  kinds?: readonly string[];
  /** 1–200, agentd's default 200. */
  limit?: number;
  cursor?: string | null;
}

export function traceEvents(q: TraceEventsQuery): Promise<TraceEventsPage> {
  const p = new URLSearchParams();
  if (q.since != null) p.set('since', q.since);
  if (q.until != null) p.set('until', q.until);
  if (q.kinds != null) p.set('kinds', q.kinds.join(','));
  if (q.limit != null) p.set('limit', String(q.limit));
  if (q.cursor != null) p.set('cursor', q.cursor);
  const qs = p.toString();
  return get<TraceEventsPage>(`/trace/events${qs ? `?${qs}` : ''}`);
}
