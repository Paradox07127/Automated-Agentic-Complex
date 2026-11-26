// Memory, observation and conversation entities. All times are epoch milliseconds.
import type { CanonicalTaskId } from './ids';
import type { FactKind, MemorySource, StageStatus, TurnResult } from './states';

/** One recent use of a fact: `injected` into a prompt or `mentioned` in a reply. */
export interface FactUse {
  /** Days ago, 0 = today (from the clock the adapter was given). */
  days_ago: number;
  how: 'injected' | 'mentioned';
  at: number;
  line_id: string;
}

/** `GET /memory` fact. */
export interface Fact {
  /** fact_id. */
  id: string;
  /** Send back as expected_version. */
  version: number;
  /** The character it is private to; null: shared by all. */
  owner: string | null;
  kind: FactKind;
  text: string;
  source: MemorySource;
  /** Present only on candidate rows; absent means active. */
  state?: 'candidate';
  recorded_at: number;
  /** "怎么得知" line. */
  how: string;
  uses_today: number;
  last_used_at: number | null;
  uses: FactUse[];
  /** Evidence score, only for observed_context and inferred_hypothesis facts. */
  score?: number;
  /** Raw evidence refs (`episode:{id}@{date}`, `agent_run:…`). */
  evidence: string[];
  /** The `episode:{id}@{date}` refs of `evidence`. */
  episode_refs: Array<{ id: string; date: string }>;
  occurred_at?: number | null;
  last_mentioned_at?: number | null;
  /** Injected every turn. */
  resident?: boolean;
  stale?: boolean;
  locked: boolean;
  /** 不再提及. */
  quiet: boolean;
}

/** `GET /memory` counts by source. */
export interface FactCounts {
  asserted_by_user: number;
  confirmed_by_user: number;
  observed_context: number;
  inferred_hypothesis: number;
}

/** `/episodes?date=` row. */
export interface Episode {
  /** String of the backend int id. */
  id: string;
  start: number;
  /** Null while ongoing. */
  end: number | null;
  title: string;
  apps: string[];
  hosts?: string[];
  description?: string;
  presence?: string;
  outcome?: string;
  edited?: boolean;
}

export interface PresenceSpan {
  start: number;
  end: number | null;
  kind: 'active' | 'away' | 'unknown';
}

/** `/attention/summary` totals in seconds. */
export interface AttentionSummary {
  active_s: number;
  afk_s: number;
  unknown_s: number;
}

/** Foreground time per app (attention summary by=app); sums to ≤ active_s. */
export interface AppTime {
  app: string;
  seconds: number;
}

export interface Conversation {
  id: string;
  character_id: string;
  title: string;
  /** Derived from pinned and updated_at against the adapter's clock. */
  group: '置顶' | '今天' | '更早';
  updated_at: number;
  created_at: number;
  /** Send back as expected_version; goes up by one on every PUT. */
  revision: number;
  pinned: boolean;
  /** Its character's active conversation. */
  active: boolean;
  turn_count: number;
  preview: string;
  /** Set by the page from the list's top-level `busy`. */
  busy?: boolean;
  archived: boolean;
}

/** One entry in a conversation stream. */
export type Message =
  | { kind: 'me'; at: number; text: string }
  /** `turn_id`: the `/trace/turns` row of this reply; absent when trace cannot pair it. */
  | { kind: 'ai'; at: number; text: string; ttft_ms?: number; turn_ms: number; turn_id?: string; state?: string; source?: string; character_id?: string }
  | { kind: 'side'; at: number; text: string; streaming?: boolean }
  | { kind: 'tool'; label: string; ms: number; summary: string; code?: string; at?: number; sessionAllowed?: boolean }
  | { kind: 'task'; task_id: CanonicalTaskId }
  /** `question_id`: 32 hex request id. */
  | { kind: 'question'; question_id: string; at: number };

/** One stage in a trace turn. Offsets are relative to the turn start. */
export interface TurnStage {
  name: string;
  start_ms: number;
  duration_ms: number;
  status: StageStatus;
}

/** `/trace/turns` row with its stages. */
export interface Turn {
  /** trace_id. */
  id: string;
  turn_id: string;
  head?: string | null;
  len?: number | null;
  producers?: string[];
  started_at: number;
  source: string;
  result: TurnResult;
  trace_result?: string;
  turn_state?: string;
  duration_ms: number;
  stages: TurnStage[];
  /** Key moments, e.g. "首字 1.24 s（模型后 0.86 s）". */
  marks: Array<{ at_ms: number; label: string }>;
}

/** One turn on the diag timeline: started_at, duration, result, source. */
export interface TurnDot {
  /** trace_id. */
  id: string;
  turn_id?: string;
  started_at: number;
  duration_ms: number;
  result: TurnResult;
  source: string;
}
