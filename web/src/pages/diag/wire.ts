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
  items: Record<string, { state: string; reason?: string | null }>;
  at: string;
}

/** GET /memory/runs row (memory_service.py `list`); times are epoch seconds. */
export interface WireMemoryRun {
  run_id: string;
  backend: string;
  model: string;
  character_id: string;
  started_at: number;
  finished_at: number | null;
  state: string;
  prompt_version: string;
  redacted_reason: string | null;
}

/** One memory write proposal and its receipt (memory_service.py `_event`, memory_pipeline.py commits). */
export interface WireMemoryProposal {
  proposal: { operation: string; text?: string; kind?: string; evidence_quote?: string; target_quote?: string };
  receipt: { outcome?: string; fact_id?: string; version?: number; error?: { code: string } };
}

/** GET /memory/runs/{id} (memory_service.py `get`); `detail` is null once redacted, `events` stay. */
export interface WireMemoryRunDetail extends WireMemoryRun {
  input_sha256: string | null;
  detail: {
    user_input: string;
    request: string;
    request_truncated: boolean;
    proposals: WireMemoryProposal[];
    output?: string | null;
    trace?: string[];
  } | null;
  events: Array<{ seq: number; at: number; event: string } & Record<string, unknown>>;
}
