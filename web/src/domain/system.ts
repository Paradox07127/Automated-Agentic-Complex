// Character, diagnostics and settings entities. All times are epoch milliseconds.
import type { PermissionKind, PermissionState } from '../bridge/protocol';
import type { RuntimeBackend } from './states';

/** `/character/state` (server.py:1407-1415). valence is baseline ± 0.6 and may be negative; values are null without a state. */
export interface CharacterState {
  character_id: string | null;
  affects_behavior: boolean;
  energy: number | null;
  valence: number | null;
  engagement: number | null;
  /** Not sent by agentd yet; the page hides what needs them. */
  baseline?: number;
  walk_scale?: number;
  comment_scale?: number;
  labels: { energy: string; mood: string; engagement: string };
  /** `NOW | 坐着`; the raw activity key. */
  activity: string | null;
  causes: StateCause[];
}

/** Event that moved a state value; at most 8 kept. */
export interface StateCause {
  attr: 'energy' | 'valence';
  cause: string;
  delta: number;
  at: number;
}

/** character_state_log point. */
export interface StatePoint {
  at: number;
  energy: number;
  valence: number;
  cause: string | null;
}

export interface CharacterProfile {
  id: string;
  name: string;
  en: string;
  active: boolean;
  /** Host art URLs (`CharacterEntry.head` / `.portrait`). */
  head?: string;
  portrait?: string;
}

/** Link health: agentd → kernel / host / voice branches. */
export interface Health {
  agentd: { up: boolean; started_at: number };
  runtime: { ready: boolean; name: string; error: string | null };
  /** ChildState: running, or backing off for N seconds. */
  avatar: { child: 'running' | 'stopped' | { backoff: number }; fps: number | null };
  /** unknown: not checked yet. retryAfterS: seconds until agentd tries an unreachable TTS again, null when it may now. */
  voice: { state: 'unknown' | 'probing' | 'ready' | 'cold' | 'unreachable' | 'off'; retryAfterS: number | null };
}

/** One second of host render stats. gpu is milliseconds. */
export interface RenderSample {
  at: number;
  fps: number | null;
  p95_ms: number | null;
  gpu_ms: number | null;
  suspended?: boolean;
}

export interface Pipeline {
  fps_target: number;
  suspended: boolean;
  gpu_allocated_mb: number;
}

export interface ProcessRow {
  name: string;
  /** Last 20 CPU % samples. */
  cpu: number[];
  memory_mb: number;
  /** Up intervals over the last 24 h; end null = still up. */
  uptime: Array<{ start: number; end: number | null }>;
}

/** Error list entry. */
export interface ErrorEntry {
  id: string;
  kind: 'task' | 'turn';
  at: number;
  title: string;
  reason: string;
  fix: string;
}

/** Diag budget row (usage.py today().by_call). `unpriced` calls have no cost in `cost_usd`. */
export interface ModelCall {
  label: string;
  calls: number;
  input_tokens: number;
  /** cache_creation_input_tokens + cache_read_input_tokens. */
  cache_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced: number;
}

/** `/diag/state` budget block plus the gate counters. A meter without data is null. */
export interface Budget {
  screenshots: { used: number; reserved: number; released: number; limit: number } | null;
  gate: { today: number; daily_limit: number; blocked_today: number };
  model: { by_call: Record<string, ModelCall>; cost_usd: number; unpriced: number } | null;
}

/** Current turn phases (`/diag/state` turn block). */
export interface TurnNow {
  /** trace_id. */
  id: string;
  turn_id: string;
  phase: string | null;
  phases_ms: Array<{ key: string; label: string; ms: number }>;
}

/** Cooldown. agentd sends only what is left, so `total_s` is null. */
export interface Cooldown {
  key: string;
  label: string;
  left_s: number;
  total_s: number | null;
}

/** Kernel runtime (`/character/runtime` installed_runtimes + available_backends). */
export interface RuntimeInfo {
  id: RuntimeBackend;
  /** available_backends title. */
  name: string;
  path: string | null;
  version: string | null;
  entry_supported: boolean;
  /** Discovery is not a tool-boundary audit; null until such evidence exists. */
  boundary_verified: boolean | null;
  /** Null when native login is not needed (Pi or the selected API-key mode). */
  authenticated: boolean | null;
  /** installed_runtimes login_command: the shell command that signs in this CLI; null for a bundled runtime or Pi. */
  login_command?: string | null;
  runtime_source?: string;
  auth_method?: string | null;
  available?: boolean;
  reason?: string | null;
}

/** Permission row with the features it unlocks. */
export interface PermissionRow {
  kind: PermissionKind;
  label: string;
  purpose: string;
  state: PermissionState;
  features: string[];
}
