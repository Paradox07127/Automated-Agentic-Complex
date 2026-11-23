// Work entities: tasks, runs, pending items, deliveries, sessions. All times are epoch milliseconds.
import type {
  DeliveryState,
  ItemStatus,
  PendingKind,
  RunPhase,
  RunState,
  SessionState,
  StepPhase,
  StepStatus,
  TaskSource,
  TaskStatus,
  VerificationSource,
} from './states';
import type { CanonicalTaskId, DeliveryId, TaskKey } from './ids';
import type { CwdFrom, DispatchSource } from './wire';

/** One step in a task's step list (task detail timeline, plan progress, overview running rows). */
export interface PlanStep {
  text: string;
  status: StepStatus;
  /** When this step started; drives the stall readout. agentd plan steps have none, so the adapter gives null. */
  since: number | null;
  /** Short result line, e.g. "git log，142 条". */
  detail?: string;
}

/** `/feed plan`. */
export interface Plan {
  revision: number;
  steps: PlanStep[];
  run_id?: string;
  title?: string;
  status?: string;
  at?: number;
}

export interface Task {
  id: TaskKey;
  /** Ledger id (`/tasks/:id/(continue|cancel)` 1–128 chars; `/tasks/:id/(accept|reject)` 1–64). */
  task_id: string | null;
  /** 32 hex; `/agent/jobs/{hex}/(cancel|resume)`. */
  job_id: string | null;
  run_id: string | null;
  generation: number;
  /** delivery.revision, 0 without a delivery. */
  revision: number;
  delivery: Delivery | null;
  redacted: boolean;
  verification_source: VerificationSource | null;
  character_id: string | null;
  updated_at: number;
  target?: 'claude' | 'codex' | 'character';
  title: string;
  source: TaskSource;
  /** Coding tool name for code/ext tasks. */
  agent?: string;
  status: TaskStatus;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  conversation_id?: string;
  goal_id?: string;
  cwd?: string;
  /** Plan steps when known; empty when the backend has none. */
  steps: PlanStep[];
  /** Completed step count (also known without a plan). */
  steps_done: number;
  /** Total steps only when the backend reports it. */
  steps_total: number | null;
  summary?: string;
  failure?: { reason: string; fix?: string };
  /** A coding task's verify result (`/tasks` result). */
  verify?: TaskVerify;
  /** A coding task's delivery id from its `/tasks` result; its 验收 is recorded against it. */
  delivery_id?: DeliveryId;
  /** Actual runs owned by this task, independent of runtime generation. */
  run_count: number;
}

/** tasks.py verify: the command's exit code and output tail, or why it did not run (no_verify_cmd, timeout, not_started …). */
export interface TaskVerify {
  exit_code: number | null;
  output_tail: string | null;
  reason: string | null;
}

/** `/agent/runs` row; the backend returns the latest 50. */
export interface Run {
  run_id: string;
  /** Ledger task id (`'character-' + run_id`), not a canonical id; null for conversation runs. */
  task_id: string | null;
  conversation_id?: string;
  generation?: number;
  started_at: number;
  ended_at: number | null;
  state: RunState;
  /** Side (read-only) run. The adapter never sets it. */
  side?: boolean;
}

/** Live run as seen by presence + feed. */
export interface ActiveRun {
  run_id: string;
  task_id: string | null;
  generation: number;
  conversation_id: string | null;
  state: RunState;
  phase: RunPhase | null;
  started_at: number;
  /** Since when `state` holds (the run's state_since). */
  since: number | null;
  /** Current tool name while state is running_tool. */
  tool?: string;
  /** Tool calls so far (fallback readout when there is no plan). */
  tools?: number;
  plan: Plan | null;
}

/** `/agent/tasks/{id}/steps` event. */
export interface StepEvent {
  step_id: string;
  run_id: string | null;
  generation: number;
  /** lifecycle, tool_call, tool_result, assistant_text, reasoning_summary, plan, other. */
  kind: string;
  status: string | null;
  /** `raw_phase` mapped onto the lanes. */
  phase: StepPhase;
  raw_phase: string | null;
  name: string | null;
  summary?: string;
  at: number;
}

/** Tool call item from `/agent/runs/{id}/items` (waterfall ticks, tool distribution). */
export interface ToolItem {
  kind: 'tool_call';
  name: string;
  status: ItemStatus;
  created_at: number;
  updated_at: number | null;
  summary?: string;
}

interface PendingBase {
  id: string;
  kind: PendingKind;
  task_id: string | null;
  title: string;
  /** "Codex · 修 HostLink 断线重连" style origin line. */
  source: string;
  /** When the item started waiting. */
  since: number;
  resolved?: boolean;
}

/** `/approvals` card (approvals.py:56-74). `since` = fetched_at − (window_s − seconds_left) s: the broker keeps no epoch start. */
export interface Approval extends PendingBase {
  kind: 'approval';
  generation: number;
  approval_kind: 'tool' | 'dispatch';
  /** Backend `source` (claude, codex, agentd …). */
  agent: string;
  display_session: string | null;
  session_id: string;
  tool: string;
  cmd?: string;
  content_preview?: string;
  summary_truncated?: boolean;
  orig_len?: number;
  cwd: string | null;
  dangerous: boolean;
  danger_rule?: string;
  options: Array<'allow' | 'allow_session' | 'deny'>;
  session_scope: { kind: string; detail: string } | null;
  dispatch: ApprovalDispatch | null;
  status: 'pending' | 'decided' | 'consumed' | 'expired' | 'cancelled' | 'abandoned';
  /** Per-card window, ≤ 55 s. */
  window_s: number;
  seconds_left: number;
  /** When the card list was read (epoch ms); `seconds_left` is relative to it. */
  fetched_at: number;
  /** Backend allows "allow for this session". */
  scope_ok?: boolean;
}

/** Dispatch card payload (sessions/dispatch.py:27-35). */
export interface ApprovalDispatch {
  target: string;
  cwd: string;
  prompt: string;
  source: DispatchSource;
  utterance: string | null;
  modes: string[];
  mode: string;
  verify_cmd: string | null;
  cwd_from: CwdFrom | null;
  /** Only on a dispatch she proposed. */
  title?: string;
}

/** One question of an interaction card (interactions.py ASK_TOOL). */
export interface QuestionItem {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

/** `/agent/interactions` request. `title` and `options` repeat the first question for older readers. */
export interface Question extends PendingBase {
  kind: 'question';
  revision: number;
  interaction_kind: 'question' | 'approval';
  state: 'pending' | 'answered' | 'resuming';
  questions: QuestionItem[];
  run_id: string;
  job_id: string | null;
  generation: number;
  /** Epoch ms; null means no deadline. */
  expires_at: number | null;
  preview_text?: string;
  /** Exact-call approvals only; absent reads as not dangerous. */
  dangerous?: boolean;
  danger_rule?: string | null;
  approval_answers?: Array<'allow' | 'allow_session' | 'deny'>;
  conversation_id: string | null;
  options: string[];
  /** Null means no deadline ("不限时"). */
  seconds_left: number | null;
}

/** A delivery waiting for accept / reject. */
export interface Review extends PendingBase {
  kind: 'review';
  task_id: CanonicalTaskId;
  delivery_id: DeliveryId;
  revision: number;
  generation: number;
  verification_source: VerificationSource;
}

export type PendingItem = Approval | Question | Review;

export interface Artifact {
  artifact_id: string;
  /** Last segment of `path`. */
  name: string;
  path: string;
  absolute_path: string;
  version: number;
  sha256: string;
  self_checked: boolean;
  validation?: { ok: boolean; checks: Array<{ check: string; ok: boolean; source_id?: string; section?: string; column?: string }> } | null;
  /** The user opened it at least once ("0/2 打开过"): agentd keeps its opened_at. */
  opened: boolean;
}

/** `personal_deliveries` row (deliveries.py:14-30). Send `revision` and `generation` back; `version` is display only. */
export interface Delivery {
  id: DeliveryId;
  task_id: CanonicalTaskId;
  /** Per-task delivery sequence; never sent as the concurrency revision. */
  version: number;
  /** Goes up by one on every receipt; use the reply's delivery next. */
  revision: number;
  generation: number;
  run_id: string;
  job_id: string | null;
  title: string;
  summary: string;
  outcome: string;
  /** Revoked: title, summary and artifacts are gone. */
  redacted: boolean;
  state: DeliveryState;
  verification_source: VerificationSource;
  produced_at: number;
  presented_at: number | null;
  viewed_at: number | null;
  decided_at: number | null;
  artifacts: Artifact[];
}

/** Coding or external session (`/sessions`). */
export interface Session {
  /** `own:<12hex>` for an own session, else display_session. */
  id: string;
  /** Own session: its dispatch card's ledger row; external session: its `ext:` row, so the row sees the session state. */
  task_id: TaskKey | null;
  kind: 'code' | 'ext';
  own: boolean;
  /** claude, codex … */
  target: string;
  display_session: string | null;
  agent: string;
  title: string;
  state: SessionState;
  since: number;
  cwd: string;
  last_line?: string | null;
}

export interface Goal {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  revision: number;
  created_at: number;
  updated_at: number;
  /** Task ids whose rows carry this goal_id; their state comes from the task list. */
  task_ids: TaskKey[];
  /** Backend `objective`. */
  note: string;
}

/** File impact. `path` is absolute. */
export interface FileEffect {
  path: string;
  op: 'read' | 'write' | 'modify';
  added?: number | null;
  removed?: number | null;
}
