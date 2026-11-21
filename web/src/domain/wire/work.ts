// agentd wire shapes for tasks, pending items, deliveries, sessions, goals and runs (see index.ts).

/** approvals.py:56-74 ApprovalRequest.to_dict; GET /approvals → {approvals}. */
export interface WireApproval {
  request_id: string;
  generation: number;
  display_session: string | null;
  source: string;
  session_id: string;
  agent_id: string | null;
  tool_name: string | null;
  tool_summary: string | null;
  kind: 'tool' | 'dispatch';
  dispatch: WireDispatch | null;
  summary_truncated: boolean;
  summary_length: number | null;
  summary_sha256: string | null;
  content_preview: string | null;
  content_preview_truncated: boolean;
  content_preview_length: number;
  content_preview_sha256: string | null;
  cwd: string | null;
  dangerous: boolean;
  danger_rule: string | null;
  options: Array<'allow' | 'allow_session' | 'deny'>;
  session_scope: { kind: string; detail: string } | null;
  status: 'pending' | 'decided' | 'consumed' | 'expired' | 'cancelled' | 'abandoned';
  window_s: number;
  seconds_left: number;
}

/** `agent`: she proposed it with dispatch_session; `utterance` is then the user's words that turn. */
export type DispatchSource = 'text' | 'voice' | 'agent';

/** Where the dispatch directory came from. */
export type CwdFrom =
  | { source: 'explicit' }
  | { source: 'focus'; display_session: string; state: string }
  | { source: 'agent'; project: string | null; matched: 'cwd' | 'project' | 'focus' | 'workspace' };

/** sessions/dispatch.py:27-35; `title` and `requested_by` only on a dispatch she proposed. */
export interface WireDispatch {
  target: string;
  cwd: string;
  prompt: string;
  source: DispatchSource;
  utterance: string | null;
  modes: string[];
  mode: string;
  verify_cmd: string | null;
  cwd_from: CwdFrom | null;
  title?: string;
  requested_by?: { run_id: string; conversation_id: string | null };
}

/** interactions.py:12-20 ask_user question. */
export interface WireQuestion {
  id: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
}

/** interactions.py:28-36,52-62 character_interactions row; GET /agent/interactions → {requests}. expires_at 0 = no deadline. */
export interface WireInteraction {
  request_id: string;
  run_id: string;
  kind: 'question' | 'approval';
  state: 'pending' | 'answered' | 'resuming';
  revision: number;
  data: {
    questions: WireQuestion[];
    preview: unknown;
    preview_text?: string;
    /** Approvals only; rows written before these keys existed read as not dangerous. */
    dangerous?: boolean;
    danger_rule?: string | null;
    approval_answers?: Array<'allow' | 'allow_session' | 'deny'>;
    character_id: string | null;
    scope_id: string | null;
    user_text: string;
    job_id: string | null;
  } | null;
  answer: unknown;
  created_at: number;
  expires_at: number;
  conversation_id: string | null;
  generation: number;
}

/** deliveries.py:18-21 ARTIFACT_FIELDS. */
export interface WireArtifact {
  artifact_id: string;
  path: string;
  absolute_path: string;
  version: number;
  self_checked: boolean;
  sha256: string;
  /** Older delivery payloads have no saved per-artifact result. */
  validation?: { ok: boolean; checks: Array<{ check: string; ok: boolean; source_id?: string; section?: string; column?: string }> } | null;
}

/** deliveries.py:14-30,91-102 personal_deliveries row plus payload. */
export interface WireDelivery {
  delivery_id: string;
  /** Stable per-task sequence, independent of runtime generation and receipt revision. */
  delivery_version?: number;
  canonical_task_id: string;
  run_id: string;
  task_id: string | null;
  job_id: string | null;
  goal_id: string | null;
  conversation_id: string | null;
  character_id: string;
  source_run_id: string | null;
  parent_run_id: string | null;
  scope_id: string | null;
  generation: number;
  revision: number;
  state: 'produced' | 'presented' | 'viewed' | 'accepted' | 'rejected';
  outcome: string;
  verification_source: 'automatic_checks' | 'unverified';
  decision_source: string | null;
  title: string;
  summary: string;
  artifacts: WireArtifact[];
  produced_at: number;
  presented_at: number | null;
  viewed_at: number | null;
  decided_at: number | null;
  redacted: boolean;
  schema_version: number;
  kind: 'task_notice';
  material_is_instruction: false;
}

/** deliveries.py:158-184 canonical task row; GET /agent/tasks → {tasks, next_cursor}. */
export interface WireTaskRow {
  canonical_task_id: string;
  task_id: string | null;
  job_id: string | null;
  goal_id: string | null;
  run_id: string | null;
  source_run_id: string | null;
  parent_run_id: string | null;
  conversation_id: string | null;
  character_id: string | null;
  generation: number;
  run_count?: number;
  title: string;
  state: string;
  created_at: number;
  updated_at: number;
  delivery: WireDelivery | null;
  revision: number;
  verification_source: 'automatic_checks' | 'unverified' | null;
  redacted: boolean;
}

/** tasks.py verify result; interrupted (own.py) and stopped (server.py stop_task) rows carry only `reason`. */
export interface WireLedgerResult {
  exit_code?: number | null;
  output_tail?: string | null;
  reason?: string | null;
}

/** tasks.py:26 COLUMNS row; GET /tasks → {tasks}. */
export interface WireLedgerTask {
  task_id: string;
  target: string;
  cwd: string;
  title: string;
  mode: string;
  state: string;
  verify_cmd: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  result: WireLedgerResult | null;
  /** Set when the character proposed the task with dispatch_session; null for text, voice and card dispatches. */
  requested_by?: { kind: 'agent'; run_id: string; conversation_id: string | null; character_id: string } | null;
}

/** server.py:3655-3676 external row and own.py:95-101 own row; GET /sessions → {sessions}. */
export interface WireSession {
  session_id: string;
  own: boolean;
  target: string;
  /** Null for an external session the registry has no cwd for. */
  cwd: string | null;
  title: string | null;
  state: string;
  last_line: string | null;
  started_at: number | null;
  updated_at: number;
  /** Own sessions: the dispatch card's request_id (bare ledger id), or null. */
  task_id?: string | null;
  cancel_requested?: boolean;
  observed_at?: number;
  mode?: string;
  pinned?: boolean;
  archived?: boolean;
  revision?: number;
  origin?: unknown;
  capabilities?: string[];
}

/** jobs.py:75 personal_goals row; GET /agent/goals → {goals}. */
export interface WireGoal {
  goal_id: string;
  title: string;
  objective: string;
  state: 'active' | 'paused' | 'completed' | 'cancelled';
  revision: number;
  created_at: number;
  updated_at: number;
}

/** store.py:29-33 character_runs row; GET /agent/runs → {runs}. */
export interface WireRun {
  run_id: string;
  conversation_id: string;
  character_id: string;
  generation: number;
  state: string;
  scope_id: string | null;
  task_id: string | null;
  sdk_session_id: string | null;
  dependencies: unknown;
  result: unknown;
  started_at: number;
  ended_at: number | null;
  delivery_eligible?: number;
  delivery_revoked?: number;
}

/** deliveries.py:320-341; GET /agent/tasks/{id}/steps → {steps, next_cursor}. */
export interface WireStep {
  step_id: string;
  run_id: string | null;
  generation: number;
  kind: string;
  status: string | null;
  phase: string | null;
  name: string | null;
  summary: string;
  at: number;
}

/** store.py:37-41 character_run_items row; GET /agent/runs/{id}/items → {items}. */
export interface WireRunItem {
  run_id: string;
  item_id: string;
  seq: number;
  kind: string;
  phase: string | null;
  status: string;
  name: string | null;
  summary: string | null;
  text: string;
  parent_item_id: string | null;
  created_at: number;
  updated_at: number;
  steps: unknown;
}
