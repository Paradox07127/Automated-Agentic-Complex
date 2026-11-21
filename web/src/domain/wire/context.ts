// agentd wire shapes for conversations, history and memory (see index.ts).

/** conversations.py:12,53,56; GET /conversations → {conversations, busy}. */
export interface WireConversation {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  revision: number;
  created_at: number;
  updated_at: number;
  turn_count: number;
  active: boolean;
}

/** history.py:9-10 COLUMNS; conversation turns (conversations.py:68) and /history rows. */
export interface WireTurn {
  id: number;
  event_id: string;
  turn_id: string | null;
  source: string;
  character_id: string;
  persona_revision: string | null;
  user_text: string;
  reply: string;
  state: string;
  started_at: number;
  ended_at: number | null;
  raw_reply?: string | null;
  conversation_id?: string | null;
}

/** memory.py:16,418-427 fact plus its uses; GET /memory → {paused, facts, counts}. */
export interface WireFact {
  fact_id: string;
  version: number;
  kind: string;
  text: string;
  source: 'asserted_by_user' | 'confirmed_by_user' | 'observed_context' | 'inferred_hypothesis';
  evidence: string[];
  occurred_at: number | null;
  recorded_at: number;
  last_used_at: number | null;
  state: 'active' | 'candidate';
  /** Not used for more than STALE_AFTER (memory.py). */
  stale: boolean;
  score: number;
  uses_today: number;
  last_injected_at: number | null;
  last_mentioned_at: number | null;
  recent_uses: Array<{
    line_id: string;
    at: number;
    mode: 'injected' | 'mentioned';
  }>;
}

/** `_episode_json` fills missing thread fields for every stored episode version. */
export interface WireEpisodeThread {
  session: string | null;
  status: string | null;
  progress: string | null;
  topic: string | null;
  blocked: boolean | null;
  evidence: number[];
  source_ids: string[];
  subject: string | null;
  goal: string | null;
  constraints: string[];
  decisions: Array<{ decision: string; reason: string }>;
  outcome: string | null;
  unresolved: string[];
  next_steps: string[];
  requires: string[];
  scope_ids: string[];
}

/** server.py:4161-4175,5006 `_episode_json`; GET /episodes?date= → {date, enabled, episodes, threads}. */
export interface WireEpisode {
  id: number;
  start: string;
  end: string;
  created_at: string;
  title: string;
  apps?: string[];
  hosts?: string[];
  description?: string;
  presence?: string;
  outcome?: string | null;
  edited?: boolean;
  threads?: WireEpisodeThread[];
  [k: string]: unknown;
}

/** attention.py:444-446; GET /attention/summary?by= → this. */
export interface WireAttention {
  since: number;
  until: number;
  active_s: number;
  afk_s: number;
  unknown_s: number;
  items: Array<{ key: string; seconds: number }>;
}

/** browser_stats.py valid_metrics `media`; positions in seconds. */
export interface WireBrowserMedia {
  kind: 'video' | 'audio';
  state: 'playing' | 'paused' | 'ended' | 'buffering';
  position_s: number | null;
  duration_s: number | null;
  playback_rate: number;
  muted: boolean;
}

/** attention.py:454-476 browser_summary; GET /attention/browser → the by=domain summary since local midnight plus the extension state. `current` is null while paused, unfocused or older than 15 s. */
export interface WireBrowser extends WireAttention {
  connected: boolean;
  focused: boolean;
  current: {
    at: number;
    url_host: string;
    scroll_percent: number | null;
    max_scroll_percent: number | null;
    tab_count: number;
    audible_tab_count: number;
    media: WireBrowserMedia | null;
  } | null;
  page_switches: number;
  samples_received: number;
}

/** capture.py:486-493 plus server.py:3205-3209; GET /diag/observations/<12 hex> → this. Never carries pixels. */
export interface WireObservationDetail {
  request_id: string;
  mode: string;
  status: string;
  reason: string | null;
  /** Null when policy or the blacklist hides the window now. */
  app: string | null;
  requested_at: string | null;
  observed_at: string | null;
  /** The view is still fresh enough to go into context. */
  current: boolean;
  /** The vision model's description, at most 4000 characters. */
  description: string | null;
  description_truncated: boolean;
  content_available: boolean;
  /** Null before any context was assembled. */
  used_in_last_turn: boolean | null;
}

/** memory_service.py:86-97 `index` via server.py `_summary_runs`; GET /summary/runs?date=&kinds= → {date, runs}, newest first, no text. */
export interface WireSummaryRun {
  run_id: string;
  /** prompt_version without `-v2`, e.g. `memory_extract`. */
  kind: string;
  started_at: string;
  span_start: string | null;
  span_end: string | null;
  /** memory_agent_runs.state. */
  outcome: string;
  error: string | null;
  attempt: number;
  duration_ms: number;
  backend: string;
  model: string;
  episode_id: number | null;
  reasons: string[];
}
