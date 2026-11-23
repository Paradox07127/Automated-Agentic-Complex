// State unions shared by every page, chart and fixture. Values follow the agentd field values.

/** Run or role state: presence `role.state` plus `/agent/runs` state. */
export type RunState =
  | 'queued'
  | 'thinking'
  | 'running_tool'
  | 'verifying'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'error'
  | 'cancelled'
  | 'interrupted'
  | 'idle'
  | 'waiting_user'
  | 'completed';

/** Presence `role.phase` (RunRing glyph). */
export type RunPhase = 'prepare' | 'tool' | 'verify' | 'awaiting';

/** `/agent/tasks/{id}/steps` phase (run waterfall lanes). */
export type StepPhase = 'prepare' | 'execute' | 'verify' | 'awaiting' | 'suspended' | 'end';

/** Job / task status (`/agent/tasks`, `/tasks`; tasks.py TRANSITIONS plus job states). */
export type TaskStatus =
  | 'proposed'
  | 'approved'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'returned'
  | 'verifying'
  | 'needs_review'
  | 'succeeded'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'denied'
  | 'expired'
  | 'interrupted'
  | 'cancelled';

/** Where a task comes from: role task, coding session dispatched by the user, external session. */
export type TaskSource = 'role' | 'code' | 'ext';

/** `/sessions` state: registry effective_state for external sessions, own.py states for own ones. */
export type SessionState = 'running' | 'awaiting_approval' | 'awaiting_input' | 'error' | 'idle' | 'accepted' | 'thinking' | 'running_tool';

/** Kind of an item waiting for the user. */
export type PendingKind = 'approval' | 'question' | 'review';

/** Plan step status (`/feed plan steps[].status`). */
export type StepStatus = 'pending' | 'in_progress' | 'waiting' | 'completed' | 'failed';

/** Tool call item status (`/agent/runs/{id}/items`). */
export type ItemStatus = 'in_progress' | 'completed' | 'failed';

/** Personal delivery state (deliveries.py). */
export type DeliveryState = 'produced' | 'presented' | 'viewed' | 'accepted' | 'rejected';

export type VerificationSource = 'auto' | 'unverified';

/** Trace turn result (DotStrip dots, turn waterfall header). */
export type TurnResult = 'ok' | 'failed' | 'interrupted' | 'skipped' | 'running' | 'unknown';

/** One stage inside a trace turn or a waterfall row. */
export type StageStatus = 'done' | 'current' | 'failed' | 'interrupted';

/** NodeChain node state (delivery chain, link health, hook chain, kernel chain, run step track fallback). */
export type NodeState = 'done' | 'ok' | 'current' | 'waiting' | 'broken' | 'unreachable' | 'todo';

/** Tone of a banner, toast or log line. */
export type Severity = 'danger' | 'warning' | 'info' | 'success' | 'neutral';

/** memory.py SOURCES. */
export type MemorySource = 'asserted_by_user' | 'confirmed_by_user' | 'observed_context' | 'inferred_hypothesis';

/** memory.py KINDS. */
export type FactKind = 'fact' | 'preference' | 'experience' | 'agreement' | 'name' | 'birthday';

/** `/character/runtime` backend (integration.py available_backends). */
export type RuntimeBackend = 'codex' | 'pi' | 'acp' | 'claude';

/** Task grouping; the task legend, tabs, overview and badges all count with it. */
export type EffectiveState = 'waiting' | 'running' | 'idle' | 'done' | 'failed' | 'stopped';

/** Colour family of a state. */
export type VisualTone = 'ok' | 'failed' | 'warning' | 'waiting' | 'running' | 'idle' | 'cancelled';

/** Shape channel of a state: ring+pulse, hollow frame+◆, ▲, ■, ✓, □, dot. */
export type VisualShape = 'ring' | 'diamond' | 'triangle' | 'square' | 'check' | 'hollow-square' | 'dot';

/** Every state value `stateVisual` understands. */
export type VisualStateKey =
  | RunState
  | TaskStatus
  | SessionState
  | StepStatus
  | DeliveryState
  | TurnResult
  | StageStatus
  | NodeState
  | EffectiveState
  | 'warning'
  | 'skipped'
  | 'blocked'
  | 'paused';
