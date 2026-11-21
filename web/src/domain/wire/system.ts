// agentd wire shapes for character state, runtime, diagnostics and trace (see index.ts).

/** server.py:1407-1415, character_state.py:156-157; GET /character/state. */
export interface WireCharacterState {
  character_id: string | null;
  energy: number | null;
  valence: number | null;
  engagement: number | null;
  activity: string | null;
  labels: { energy: string; mood: string; engagement: string } | null;
  causes: Array<{
    attr: 'energy' | 'valence';
    cause: string;
    delta: number;
    at: string;
  }>;
  affects_behavior: boolean;
}

/** server.py:4662, character_state.py:170; GET /character/state/history → {items}. */
export interface WireStatePoint {
  at: number;
  energy: number;
  valence: number;
  cause: string | null;
}

/** discovery.py:164-168 installed runtime. */
export interface WireInstalledRuntime {
  backend: 'codex' | 'claude';
  runtime_source: 'local' | 'local_cli' | 'app_cli' | 'bundled';
  path: string;
  version: string;
  entry_supported: boolean;
  boundary_verified: boolean | null;
  reason: string | null;
  authenticated: boolean;
  auth_method?: string | null;
  [k: string]: unknown;
}

/** integration.py:313-324 available_backends row. */
export interface WireBackend {
  id: 'codex' | 'pi' | 'acp' | 'claude';
  title: string;
  available: boolean;
  reason: string | null;
}

/** settings.py ROUTES: the purposes that can run on their own kernel. */
export type WireRoutePurpose = 'chat' | 'background' | 'judge' | 'understand' | 'memory' | 'computer';

/** One `routes` entry. null model: the main model on the main kernel, else the kernel's own; null effort: the product default, 'inherit' the harness's own. */
export interface WireRoute {
  backend: 'codex' | 'pi' | 'acp' | 'claude';
  /** ACP registry id of a local agent; set only when `backend` is acp. */
  acp_agent: string | null;
  model: string | null;
  effort: 'inherit' | 'low' | 'medium' | 'high' | null;
}

/** integration.py public() `routes` row; a row that follows the main kernel carries its backend and readiness. */
export interface WireRouteStatus extends WireRoute {
  follows_main: boolean;
  ready: boolean;
  error: string | null;
}

/** settings.py DEFAULTS: the 19 keys PUT /character/runtime takes. */
export interface WireRuntimeSettings {
  backend: 'codex' | 'pi' | 'acp' | 'claude';
  runtime_source: 'local' | 'bundled';
  executable: string | null;
  auth_source: 'existing_login' | 'api_key' | 'product_login' | 'local_no_auth';
  provider: string;
  model: string;
  /** Pi only. */
  max_budget_usd: number;
  scope_id: string | null;
  interactive_tools: boolean;
  history_retention: 'keep' | '7d' | '30d';
  web_access: 'off' | 'search' | 'search_and_fetch';
  /** Purposes on their own kernel; a purpose without an entry follows the main one. */
  routes: Partial<Record<WireRoutePurpose, WireRoute>>;
  /** null is off; fallback: the chat model answers while no kernel is ready. */
  /** ACP registry id; required when `backend` is acp. */
  acp_agent: string | null;
  acp_launcher: 'local' | 'npx' | 'uvx';
  /** Where bridged harnesses work; null is ~/AgenticComplex. */
  workspace_dir: string | null;
  /** auto: the language of the user's latest clear message; harness: no language instruction, the harness's own configuration decides. */
  reply_language: 'auto' | 'zh-Hans' | 'en' | 'ja' | 'harness';
  /** Pi only: an approval card before Pi's own bash, powershell, write and edit calls. */
  pi_tool_approval: boolean;
}

/** integration.py _pi_ready: the last Pi session with Pi's own tools, from its runner's ready frame. */
export interface WirePiSession {
  sdk_version: string;
  /** Pi's own tools this machine runs. */
  builtin_tools: string[];
  /** Tool -> why it is left out (bash_not_found, rg_not_found, fd_not_found, powershell_not_found). */
  builtin_tools_unavailable: Record<string, string>;
  /** The shells Pi found; powershell only on Windows. */
  shell: { bash: string | null; powershell: string | null };
  /** bash, powershell, write and edit wait for an approval card. */
  tool_approval: boolean;
  workspace_dir: string | null;
}

/** integration.py:369-376 public(); GET /character/runtime. */
export interface WireRuntimePublic extends WireRuntimeSettings {
  routes: Record<WireRoutePurpose, WireRouteStatus>;
  ready: boolean;
  error: string | null;
  auto_selected: boolean;
  available_backends: WireBackend[];
  installed_runtimes: WireInstalledRuntime[];
  selected_runtime: WireInstalledRuntime | null;
  busy: boolean;
  /** cost_limit_supported: the kernel stops a run at max_budget_usd; catalog_priced: Pi's catalog prices the main model. */
  capability_flags?: Record<string, boolean>;
  capabilities?: unknown;
  /** null until a Pi session with Pi's own tools has started in this agentd. */
  pi_session: WirePiSession | null;
}

/** usage.py today() row (total and each by_call / by_channel entry). */
export interface WireUsage {
  calls: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced: number;
  incomplete?: number;
  failed?: number;
  cancelled?: number;
  local?: number;
  usage_missing?: number;
  pricing_unverified?: number;
}

/** server.py:2810-2815 /diag/state budget block. */
export interface WireDiagBudget {
  screenshots: {
    used: number;
    reserved: number;
    released: number;
    limit: number;
  } | null;
  model:
    | (WireUsage & {
        by_call: Record<string, WireUsage>;
        by_channel: Record<string, WireUsage>;
      })
    | null;
  redactions: { key: number; email: number; phone: number } | null;
  updated_at?: string;
}

/** server.py:2747-2762 /diag/state gate block. cooldown_s is {kind: seconds left}. */
export interface WireDiagGate {
  enabled: boolean;
  companion_mode: boolean;
  quiet_hours: number[];
  meeting: boolean;
  fullscreen: boolean;
  user_speaking: boolean;
  cooldown_s: Record<string, number>;
  cross_cooldown_s: number;
  today: number;
  daily_limit: number;
  blocked_today: number;
  updated_at?: string;
}

/** server.py:2711-2728 /diag/state turn block; phases_ms is {phase: ms}. */
export interface WireDiagTurn {
  turn_id: string | null;
  trace_id: string | null;
  source: string | null;
  generation: number | null;
  phase: string | null;
  phases_ms: Record<string, number>;
  /** Completed lines checked against the reply language since agentd started; mismatched: clearly in another language. */
  language: { lines: number; mismatched: number };
  updated_at?: string;
}

/** server.py:2764-2789 /diag/state hooks block. */
export type WireDiagHooks = Record<'claude' | 'codex', { installed: boolean | null; last_at: string | null }> & { updated_at?: string };

/** voice_provider.py VoiceState.wire; POST /voice/reset answers `{tts: WireVoice}`. retry_after_s: seconds left of the TTS negative cache, null when none. */
export interface WireVoice {
  provider: 'remote-ws' | 'none';
  state: 'unknown' | 'probing' | 'ready' | 'cold' | 'unreachable' | 'off';
  reason: string | null;
  retry_after_s: number | null;
}

/** POST /voice/test (C6 CONTRACT): times from the POST to the first audio and to complete; reason null on success. */
export interface WireVoiceTest {
  ok: boolean;
  first_audio_ms: number | null;
  total_ms: number | null;
  reason: string | null;
}

/** diagnostics.py _diag_connections: the /diag/state connections block. */
export interface WireDiagConnections {
  agentd: { started_at: string; epoch: unknown };
  tts: { configured: boolean; result: string | null; at: string | null } & WireVoice;
  browser: { last_message_at: string | null };
  avatar: { speech_readers: number; heartbeat_at: string | null };
  updated_at?: string;
}

/** server.py:1265-1272 observation_state (GET /state observation and its PUT replies). */
export interface WireObservation {
  paused_until: string | null;
  quiet_until: string | null;
  meeting: boolean;
  off: boolean;
}

/** server.py:2799-2808 /diag/state observation block. */
export interface WireDiagObservation extends WireObservation {
  policy_epoch: unknown;
  pending: Array<{
    request_id: string;
    window_id: unknown;
    mode: string;
    reason: string | null;
    waited_ms: number;
  }>;
  recent: Array<{
    request_id: string;
    mode: string;
    state: string;
    reason: string | null;
    at: string;
  }>;
  updated_at?: string;
}

/** trace_store.py:252-257; GET /trace/turns → {turns}. */
export interface WireTraceTurn {
  trace_id: string;
  turn_id: string;
  source: string;
  head: string | null;
  len: number | null;
  producers: string[];
  started_at: string;
  result: string;
  duration_ms: number;
  provider?: string | null;
  account_label?: string | null;
  model?: string | null;
  error_code?: string | null;
  turn_state?: string | null;
  turn_outcome?: string | null;
  conversation_id?: string | null;
}

type Stamped<T> = T & { updated_at: string };

type Conn = 'connected' | 'not_connected';

/** server.py `_diag_context`: what the last turn was given and what she sees now; text values are {len, head}. */
export interface WireContextBlock {
  items: Array<{ type: string; observation_id: string | null; at: string; reason?: string; expires_at: string | null; expired: boolean }>;
  window: { app: string | null; title: { len: number; head: string } | null } | null;
  activity: { activity: string; confidence: number; corrected: boolean; until: string | null; mode: string; state: string } | null;
  sources: { screenshots: Conn; window_text: Conn; page_text: Conn };
}

/** server.py `_diag_voice`. voice is null without a speech relay. */
export interface WireDiagVoice {
  mouth: 'busy' | 'idle';
  voice: string | null;
  muted: boolean;
  avatar_visible: boolean;
  /** `at`: ISO time (server.py `_iso`). */
  speech_failed: { speech_id: string; reason: string | null; at: string } | null;
}

/** server.py `_diag_proactive`. */
export interface WireDiagProactive {
  focus: { category: string; dwell_s: number } | null;
  next_judge_at: string | null;
  held: 'companion_off' | null;
  last_judge: { backend: string; answers: unknown; at: string } | null;
  misses: number | null;
  factor: number | null;
}

/** server.py `_diag_rituals`. */
export interface WireDiagRituals {
  pending: string[];
  today: Array<{ at: string; [k: string]: unknown }>;
}

/** spatial.py `diag()`; `running[].since` is ISO here. */
export interface WireDiagBehavior {
  running: Array<{ behavior_id: string; type: string; target: unknown; since: string }>;
  switches: { stay_in_place: boolean; sit_window_top: boolean; hold_window_edge: boolean; fullscreen_give_way: boolean; bust_framing?: boolean };
  last_receipt: { behavior_id: string; phase: string; reason: string | null; at: string } | null;
  capability_character: string | null;
  capabilities: Record<string, string | null> | null;
  unsupported: Record<string, number>;
}

/** GET /diag/state and each `state` item of the diag stream (server.py `diag_state`): 15 blocks, each with updated_at. */
export interface WireDiagState {
  hooks: Stamped<WireDiagHooks>;
  turn: Stamped<WireDiagTurn>;
  mouth_voice: Stamped<WireDiagVoice>;
  gate: Stamped<WireDiagGate>;
  proactive: Stamped<WireDiagProactive>;
  observation: Stamped<WireDiagObservation>;
  body: Stamped<{ activity: string | null; mood: string | null }>;
  sessions: Stamped<{ sessions: Array<{ display_session: string; effective_state: string; observed_at: string; stale: boolean }> }>;
  budget: Stamped<WireDiagBudget>;
  connections: Stamped<WireDiagConnections>;
  context: Stamped<WireContextBlock>;
  behavior: Stamped<WireDiagBehavior>;
  character_state: Stamped<WireCharacterState>;
  interaction: Stamped<{
    name: string;
    model_every: number;
    model_refresh: number;
    proactive_speech: boolean;
    same_cooldown: number;
    random_tick_scale: number;
    wander_scale: number;
    focus_walk_probability: number;
  }>;
  rituals: Stamped<WireDiagRituals>;
}
