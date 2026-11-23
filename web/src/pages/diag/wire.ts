// Trace events and run rows only the diag page reads, as agentd sends them; the /diag/state blocks are in domain/wire.
/** trace_store.py event (`_emit`); `text` only with `?with_text=1`. */
export interface WireTraceEvent {
  event_id: string;
  trace_id: string;
  turn_id: string | null;
  kind: string;
  status: string;
  t_wall: string;
  t_mono_ms?: number;
  producer?: string;
  producer_epoch?: number;
  span_id?: string;
  parent_span_id?: string | null;
  duration_ms?: number;
  attrs: Record<string, unknown>;
  text?: Record<string, string>;
}

/** A `trace` or `decision` item of the diag stream (server.py `_trace`); `at` is when agentd published it. */
export interface WireDiagItem {
  event_id: string | null;
  trace_id: string;
  turn_id: string | null;
  kind: string;
  producer: string;
  status: string;
  duration_ms: number | null;
  at: string;
  attrs: Record<string, unknown>;
}

/** GET /trace/turns/{trace_id} (trace_store.py `turn`). */
export interface WireTurnEvents {
  trace_id: string;
  events: WireTraceEvent[];
  skew_ms: Record<string, number>;
}

/** GET /capabilities (capabilities.py `collect`). */
export interface WireCapabilities {
  /** The plug-ins agentd started with. */
  plugins: Record<string, boolean>;
  items: Record<string, { state: string; reason?: string | null }>;
  at: string;
}
