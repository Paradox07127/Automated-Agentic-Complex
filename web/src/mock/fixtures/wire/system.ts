// Character state, runtime, diagnostics and trace rows as agentd sends them.
import type {
  WireCharacterState,
  WireDiagBudget,
  WireDiagConnections,
  WireDiagGate,
  WireDiagHooks,
  WireDiagTurn,
  WireObservation,
  WireRuntimePublic,
  WireTraceTurn,
  WireUsage,
  WireVoice,
} from '../../../domain/wire';
import { isoAt } from '../clock';
import { C1, CHARACTER } from '../ids';

/** `GET /character/state`. The task_failed cause is T6's failure at 10:15. */
export const WIRE_CHARACTER_STATE: WireCharacterState = {
  character_id: CHARACTER,
  energy: 0.31,
  valence: -0.1,
  engagement: 0.72,
  activity: 'sitting',
  labels: { energy: 'sleepy', mood: 'low', engagement: 'absorbed' },
  causes: [
    { attr: 'valence', cause: 'task_failed', delta: -0.08, at: isoAt(10, 15) },
    { attr: 'valence', cause: 'task_verified', delta: 0.06, at: isoAt(11, 2) },
    { attr: 'energy', cause: 'session_done', delta: 0.05, at: isoAt(12, 40) },
    { attr: 'energy', cause: 'session_error', delta: -0.12, at: isoAt(13, 40) },
    { attr: 'valence', cause: 'user_spoke', delta: 0.04, at: isoAt(14, 22) },
  ],
  affects_behavior: true,
};

const installed = (backend: 'codex', path: string, version: string) => ({
  backend,
  runtime_source: 'local' as const,
  path,
  version,
  entry_supported: true,
  boundary_verified: null,
  reason: null,
  compatibility: { strategy: 'runtime_capabilities', version_required: false, policy_verification: 'on_session_start' },
  authenticated: true,
  auth_mode: 'existing_login',
  auth_method: 'existing_login',
  login_command: `${path} login`,
});

/** `GET /character/runtime` (integration.py public()): the 19 settings keys, each purpose's route and discovery. */
export const WIRE_RUNTIME: WireRuntimePublic = {
  backend: 'codex',
  runtime_source: 'local',
  executable: null,
  auth_source: 'existing_login',
  provider: '',
  model: '',
  max_budget_usd: 1,
  scope_id: null,
  interactive_tools: true,
  history_retention: 'keep',
  web_access: 'off',
  routes: {
    ...Object.fromEntries(
      (['chat', 'background', 'judge', 'understand', 'memory', 'computer'] as const).map((p) => [p, { backend: 'codex', acp_agent: null, model: null, effort: null, follows_main: true, ready: true, error: null }]),
    ),
    quick: { backend: 'pi', acp_agent: null, model: null, effort: null, follows_main: false, ready: true, error: null },
  } as WireRuntimePublic['routes'],
  acp_agent: null,
  acp_launcher: 'local',
  workspace_dir: null,
  reply_language: 'auto',
  pi_tool_approval: true,
  ready: true,
  error: null,
  auto_selected: false,
  available_backends: [
    { id: 'codex', title: 'Codex', available: true, reason: null },
    { id: 'pi', title: 'Pi', available: true, reason: null },
  ],
  installed_runtimes: [installed('codex', '/opt/homebrew/bin/codex', '0.51.0')],
  selected_runtime: installed('codex', '/opt/homebrew/bin/codex', '0.51.0'),
  busy: false,
  pi_session: {
    sdk_version: '1.4.0',
    builtin_tools: ['read', 'bash', 'edit', 'write', 'ls'],
    builtin_tools_unavailable: { grep: 'rg_not_found', find: 'fd_not_found' },
    shell: { bash: '/bin/bash', powershell: null },
    tool_approval: true,
    workspace_dir: '/Users/demo/AgenticComplex',
  },
  product_login: { pending: null, error: null, detail: null, accounts: {} },
};

const usage = (calls: number, input: number, cacheWrite: number, cacheRead: number, output: number, cost: number, unpriced = 0): WireUsage => ({
  calls,
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
  cost_usd: cost,
  unpriced,
  incomplete: 0,
  failed: 0,
  cancelled: 0,
  local: 0,
  usage_missing: 0,
  pricing_unverified: 0,
});

const BY_CALL = {
  mouth: usage(61, 412_000, 88_000, 300_000, 40_000, 0.29),
  character_agent: usage(12, 150_000, 30_000, 60_000, 10_000, 0, 12),
  observe_summary: usage(96, 80_000, 2000, 10_000, 8000, 0.08),
  decision: usage(45, 38_000, 3000, 5000, 4000, 0.05),
};

const sum = (rows: WireUsage[]): WireUsage =>
  rows.reduce((a, b) =>
    usage(
      a.calls + b.calls,
      a.input_tokens + b.input_tokens,
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
      a.cache_read_input_tokens + b.cache_read_input_tokens,
      a.output_tokens + b.output_tokens,
      a.cost_usd + b.cost_usd,
      a.unpriced + b.unpriced,
    ),
  );

/** `/diag/state` budget block. by_call tokens sum to 1.24 M; character runs (Codex) are unpriced. */
export const WIRE_DIAG_BUDGET: WireDiagBudget = {
  screenshots: { used: 37, reserved: 1, released: 3, limit: 200 },
  model: { ...sum(Object.values(BY_CALL)), cost_usd: 0.42, by_call: BY_CALL, by_channel: {} },
  redactions: { key: 2, email: 5, phone: 0 },
  updated_at: isoAt(14, 32),
};

/** `/diag/state` gate block; cooldown_s lists only kinds still cooling down. */
export const WIRE_DIAG_GATE: WireDiagGate = {
  enabled: true,
  companion_mode: true,
  quiet_hours: [22, 8],
  meeting: false,
  fullscreen: false,
  user_speaking: false,
  cooldown_s: { proactive: 180, rest: 1440 },
  cross_cooldown_s: 0,
  today: 6,
  daily_limit: 12,
  blocked_today: 3,
  updated_at: isoAt(14, 31, 2),
};

/** `/diag/state` turn block for the turn in progress (trace tr0). */
export const WIRE_DIAG_TURN: WireDiagTurn = {
  turn_id: 'turn-tr0',
  trace_id: 'tr0',
  source: 'text',
  generation: 41,
  phase: 'calling_model',
  phases_ms: { received: 40, assembling: 260, calling_model: 1240 },
  language: { lines: 23, mismatched: 1 },
  updated_at: isoAt(14, 32, 4),
};

/** `/diag/state` hooks block. */
export const WIRE_DIAG_HOOKS: WireDiagHooks = {
  claude: { installed: true, last_at: isoAt(14, 29) },
  codex: { installed: true, last_at: null },
};

type WireTts = WireDiagConnections['tts'];
const remote = (state: WireVoice['state'], reason: string | null, retry_after_s: number | null = null): Pick<WireTts, keyof WireVoice> => ({ provider: 'remote-ws', state, reason, retry_after_s });

/** `/diag/state` connections.tts in each voice state; off is the packaged build, which has no tts_url. */
export const WIRE_TTS: Record<WireVoice['state'], WireTts> = {
  unknown: { configured: true, result: null, at: null, token_set: true, ...remote('unknown', null) },
  probing: { configured: true, result: null, at: null, token_set: true, ...remote('probing', null) },
  ready: { configured: true, result: 'complete', at: isoAt(14, 20), token_set: true, ...remote('ready', null) },
  cold: { configured: true, result: 'complete', at: isoAt(13, 40), token_set: true, ...remote('cold', 'probe:ConnectionRefusedError') },
  unreachable: { configured: true, result: 'connection_lost', at: isoAt(14, 20), token_set: true, ...remote('unreachable', 'connection_lost') },
  off: { configured: false, result: null, at: null, token_set: false, provider: 'none', state: 'off', reason: 'not_configured', retry_after_s: null },
};

/** `/diag/state` connections block. */
export const WIRE_DIAG_CONNECTIONS: WireDiagConnections = {
  agentd: { started_at: isoAt(13, 20), epoch: 7 },
  tts: WIRE_TTS.unreachable,
  browser: { last_message_at: isoAt(14, 31) },
  avatar: { speech_readers: 1, heartbeat_at: null },
};

/** `GET /state` observation block: nothing paused. */
export const WIRE_OBSERVATION: WireObservation = { paused_until: null, quiet_until: null, meeting: false, off: false };

/** `GET /trace/turns` rows (trace_store.py:252-257), newest first. */
export const WIRE_TRACE_TURNS: WireTraceTurn[] = [
  { trace_id: 'tr0', turn_id: 'turn-tr0', source: 'text', head: '顺便查下 HostLink', len: 22, producers: ['agentd'], started_at: isoAt(14, 32, 4), result: 'open', duration_ms: 2600, conversation_id: C1 },
  { trace_id: 'tr2', turn_id: 'turn-tr2', source: 'proactive', head: null, len: null, producers: ['agentd'], started_at: isoAt(14, 31, 2), result: 'blocked', duration_ms: 400, conversation_id: null },
  { trace_id: 'tr5', turn_id: 'turn-tr5', source: 'observe', head: null, len: null, producers: ['agentd'], started_at: isoAt(14, 24, 3), result: 'failed', duration_ms: 900, conversation_id: null },
];
