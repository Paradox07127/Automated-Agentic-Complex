// agentd task, pending, session and goal rows → domain objects.
// Pure functions: anything clock-dependent takes the clock as an argument.
import type { CanonicalTaskId, DeliveryId, TaskKey } from '../ids';
import { toCanonical } from '../ids';
import type { SessionState, TaskSource, TaskStatus, VerificationSource } from '../states';
import { secToMs, secToMsOrNull } from '../units';
import type { WireApproval, WireDelivery, WireGoal, WireInteraction, WireLedgerTask, WireRun, WireSession, WireTaskRow } from '../wire';
import type { Approval, Artifact, Delivery, Goal, Question, Review, Session, Task, TaskVerify } from '../work';
import { sessionName } from './names';

/** Display name of a coding agent (`source` / `target`). */
export const AGENT_NAME: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agentd: 'Agentic Complex',
};
const agentName = (key: string) => AGENT_NAME[key] ?? key;

const lastSegment = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

const verification = (v: string | null): VerificationSource => (v === 'automatic_checks' ? 'auto' : 'unverified');

// ---- tasks and pending items ----

/** `/approvals` card read at `fetchedAtMs`. */
export function fromApproval(w: WireApproval, fetchedAtMs: number): Approval {
  const tool = w.tool_name ?? '';
  const agent = agentName(w.source);
  return {
    id: w.request_id,
    kind: 'approval',
    task_id: w.kind === 'dispatch' ? toCanonical(w.request_id) : null,
    title: `${tool}: ${w.tool_summary ?? ''}`,
    // The session id stays in display_session; the card shows it only as a tooltip.
    source: w.cwd ? `${agent} │ ${sessionName(w.cwd)}` : agent,
    since: fetchedAtMs - secToMs(w.window_s - w.seconds_left),
    generation: w.generation,
    approval_kind: w.kind,
    agent: w.source,
    display_session: w.display_session,
    session_id: w.session_id,
    tool,
    ...(w.tool_summary != null ? { cmd: w.tool_summary } : {}),
    ...(w.content_preview != null ? { content_preview: w.content_preview } : {}),
    summary_truncated: w.summary_truncated,
    ...(w.summary_length != null ? { orig_len: w.summary_length } : {}),
    cwd: w.cwd,
    dangerous: w.dangerous,
    ...(w.danger_rule != null ? { danger_rule: w.danger_rule } : {}),
    ...(w.trace_id != null ? { trace_id: w.trace_id } : {}),
    options: w.options,
    session_scope: w.session_scope,
    dispatch: w.dispatch
      ? {
          target: w.dispatch.target,
          cwd: w.dispatch.cwd,
          prompt: w.dispatch.prompt,
          source: w.dispatch.source,
          utterance: w.dispatch.utterance,
          modes: w.dispatch.modes,
          mode: w.dispatch.mode,
          verify_cmd: w.dispatch.verify_cmd,
          cwd_from: w.dispatch.cwd_from,
          ...(w.dispatch.title != null ? { title: w.dispatch.title } : {}),
        }
      : null,
    status: w.status,
    window_s: w.window_s,
    seconds_left: w.seconds_left,
    fetched_at: fetchedAtMs,
    scope_ok: w.options.includes('allow_session'),
  };
}

/** `/agent/interactions` request; `seconds_left` counts from `nowMs`. */
export function fromInteraction(w: WireInteraction, nowMs: number): Question {
  const questions = (w.data?.questions ?? []).map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options ?? [],
  }));
  const first = questions[0];
  const jobId = w.data?.job_id ?? null;
  return {
    id: w.request_id,
    kind: 'question',
    task_id: jobId ? `job:${jobId}` : null,
    title: first?.question ?? '',
    source: w.kind === 'approval' ? '角色 │ 请求批准' : '角色',
    since: secToMs(w.created_at),
    resolved: w.state !== 'pending',
    revision: w.revision,
    interaction_kind: w.kind,
    state: w.state,
    questions,
    run_id: w.run_id,
    job_id: jobId,
    generation: w.generation,
    expires_at: w.expires_at === 0 ? null : secToMs(w.expires_at),
    ...(w.data?.preview_text != null ? { preview_text: w.data.preview_text } : {}),
    ...(w.data?.dangerous != null ? { dangerous: w.data.dangerous, danger_rule: w.data.danger_rule ?? null } : {}),
    ...(w.data?.approval_answers != null ? { approval_answers: w.data.approval_answers } : {}),
    conversation_id: w.conversation_id,
    options: (first?.options ?? []).map((o) => o.label),
    seconds_left: w.expires_at === 0 ? null : Math.max(0, w.expires_at - nowMs / 1000),
  };
}

function fromArtifact(w: WireDelivery['artifacts'][number]): Artifact {
  return {
    artifact_id: w.artifact_id,
    name: lastSegment(w.path),
    path: w.path,
    absolute_path: w.absolute_path,
    version: w.version,
    sha256: w.sha256,
    self_checked: w.self_checked,
    validation: w.validation ?? null,
    opened: w.opened_at != null,
  };
}

export function fromDelivery(w: WireDelivery): Delivery {
  return {
    id: w.delivery_id as DeliveryId,
    task_id: w.canonical_task_id as CanonicalTaskId,
    version: w.delivery_version ?? 1,
    revision: w.revision,
    generation: w.generation,
    run_id: w.run_id,
    job_id: w.job_id,
    title: w.title,
    summary: w.summary,
    outcome: w.outcome,
    redacted: w.redacted,
    state: w.state,
    verification_source: verification(w.verification_source),
    produced_at: secToMs(w.produced_at),
    presented_at: secToMsOrNull(w.presented_at),
    viewed_at: secToMsOrNull(w.viewed_at),
    decided_at: secToMsOrNull(w.decided_at),
    artifacts: w.artifacts.map(fromArtifact),
  };
}

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'accepted', 'rejected', 'failed', 'denied', 'expired', 'cancelled', 'interrupted']);
const CODE_TARGETS: ReadonlySet<string> = new Set(['claude', 'codex']);

function sourceOf(jobId: string | null, target: string | undefined): TaskSource {
  if (jobId || target === 'character') return 'role';
  return target && CODE_TARGETS.has(target) ? 'code' : 'role';
}

/** The ledger row's verify result; null when it has none. */
function verifyOf(r: WireLedgerTask['result'] | undefined): TaskVerify | null {
  if (!r || (r.exit_code == null && r.output_tail == null && r.reason == null)) return null;
  return { exit_code: r.exit_code ?? null, output_tail: r.output_tail ?? null, reason: r.reason ?? null };
}

/** `/agent/tasks` row, with its `/tasks` ledger row when there is one and the run it points at for `started_at`. */
export function fromTaskRow(row: WireTaskRow, ledger?: WireLedgerTask, run?: WireRun): Task {
  const target = ledger?.target ?? (row.job_id ? 'character' : undefined);
  const source = sourceOf(row.job_id, target);
  const delivery = row.delivery ? fromDelivery(row.delivery) : null;
  const updated = secToMs(row.updated_at);
  const verify = verifyOf(ledger?.result);
  const currentRun = run?.run_id === row.run_id ? run : undefined;
  const ended = secToMsOrNull(currentRun?.ended_at);
  const produced = delivery?.run_id === row.run_id ? delivery?.produced_at : undefined;
  return {
    id: row.canonical_task_id as CanonicalTaskId,
    task_id: row.task_id,
    job_id: row.job_id,
    run_id: row.run_id,
    generation: row.generation,
    revision: row.revision,
    delivery,
    redacted: row.redacted,
    verification_source: row.verification_source == null ? null : verification(row.verification_source),
    character_id: row.character_id,
    updated_at: updated,
    ...(target === 'claude' || target === 'codex' || target === 'character' ? { target } : {}),
    title: row.title,
    source,
    ...(source === 'code' && target ? { agent: agentName(target) } : {}),
    status: row.state as TaskStatus,
    created_at: secToMs(row.created_at),
    started_at: currentRun ? secToMs(currentRun.started_at) : null,
    ended_at: ended ?? (TERMINAL.has(row.state) ? updated : row.state === 'needs_review' ? produced ?? null : null),
    ...(row.conversation_id ? { conversation_id: row.conversation_id } : {}),
    ...(row.goal_id ? { goal_id: row.goal_id } : {}),
    ...(ledger?.cwd ? { cwd: ledger.cwd } : {}),
    steps: [],
    steps_done: 0,
    steps_total: null,
    ...(delivery?.summary ? { summary: delivery.summary } : {}),
    ...(verify ? { verify } : {}),
    ...(ledger?.result?.delivery_id ? { delivery_id: ledger.result.delivery_id as DeliveryId } : {}),
    run_count: row.run_count ?? (row.run_id ? 1 : 0),
  };
}

/** `/tasks` ledger row with no `/agent/tasks` counterpart. */
export function fromLedgerTask(l: WireLedgerTask): Task {
  const source = sourceOf(null, l.target);
  const updated = secToMs(l.updated_at);
  const verify = verifyOf(l.result);
  return {
    id: toCanonical(l.task_id),
    task_id: l.task_id,
    job_id: null,
    run_id: null,
    generation: 0,
    revision: 0,
    delivery: null,
    redacted: false,
    verification_source: null,
    character_id: null,
    updated_at: updated,
    ...(l.target === 'claude' || l.target === 'codex' || l.target === 'character' ? { target: l.target } : {}),
    title: l.title,
    source,
    ...(source === 'code' ? { agent: agentName(l.target) } : {}),
    status: l.state as TaskStatus,
    created_at: secToMs(l.created_at),
    started_at: l.state === 'proposed' || l.state === 'approved' ? null : secToMs(l.created_at),
    ended_at: TERMINAL.has(l.state) ? updated : null,
    cwd: l.cwd,
    steps: [],
    steps_done: 0,
    steps_total: null,
    ...(verify ? { verify } : {}),
    ...(l.result?.delivery_id ? { delivery_id: l.result.delivery_id as DeliveryId } : {}),
    run_count: 0,
  };
}

/** A coding task waiting for 验收: its delivery is its verify result, settled at `/tasks/:id/accept|reject` (api/sessions.py _task_review). */
export const isCodingReview = (t: Task): t is Task & { task_id: string; delivery_id: DeliveryId } =>
  t.source === 'code' && t.target !== 'character' && t.status === 'needs_review' && t.task_id != null && t.delivery_id != null;

/** The 待处理 item of a coding task waiting for 验收. */
export function fromCodingReview(t: Task & { task_id: string; delivery_id: DeliveryId }): Review {
  return {
    id: `c-${t.task_id}`,
    kind: 'review',
    task_id: t.id as CanonicalTaskId,
    delivery_id: t.delivery_id,
    title: t.title,
    source: `${t.agent ?? '编码工具'} │ ${t.title}`,
    since: t.updated_at,
    revision: 0,
    generation: 0,
    verification_source: 'unverified',
  };
}

/** A session as its own task row: an external one as `ext:<display_session>`, an own one no dispatch card names under its session id. */
function sessionTask(s: Session): Task {
  return {
    id: s.own ? (s.id as TaskKey) : `ext:${s.display_session ?? s.id}`,
    task_id: null,
    job_id: null,
    run_id: null,
    generation: 0,
    revision: 0,
    delivery: null,
    redacted: false,
    verification_source: null,
    character_id: null,
    updated_at: s.since,
    title: s.title,
    source: s.own ? 'code' : 'ext',
    ...(s.own ? { target: s.target === 'codex' ? ('codex' as const) : ('claude' as const) } : {}),
    agent: s.agent,
    status: 'running',
    created_at: s.since,
    started_at: s.since,
    ended_at: null,
    cwd: s.cwd,
    steps: [],
    steps_done: 0,
    steps_total: null,
    run_count: 1,
  };
}

/**
 * One task list: `/agent/tasks` rows first; a ledger row already listed there as `task:<id>` is dropped (tk:11);
 * every external session adds an `ext:` row, and every own session no dispatch card names a row of its own.
 */
export function mergeTasks(agentTasks: readonly Task[], ledger: readonly Task[], sessions: readonly Session[] = []): Task[] {
  // A job row carries its run's ledger id (`character-<run_id>`) as task_id; that ledger row is the same task.
  const seen = new Set<string>(agentTasks.flatMap((t) => (t.task_id ? [t.id, `task:${t.task_id}`] : [t.id])));
  return [...agentTasks, ...ledger.filter((t) => !seen.has(t.id)), ...sessions.filter((s) => !s.own || s.task_id === s.id).map(sessionTask)];
}

const SESSION_STATES: ReadonlySet<string> = new Set(['running', 'awaiting_approval', 'awaiting_input', 'error', 'idle', 'accepted', 'thinking', 'running_tool']);
/** registry.py states with no work in progress. */
const IDLE_STATES: ReadonlySet<string> = new Set(['done', 'stale']);

/** `/sessions` row. An own session's task is the ledger row of its dispatch card, else its own row; an external one maps to its `ext:` row. */
export function fromSession(w: WireSession): Session {
  // An external row's session_id is the registry's display_session.
  const display = w.own ? null : w.session_id;
  let task: TaskKey | null = null;
  if (w.own) task = w.task_id ? toCanonical(w.task_id) : (w.session_id as TaskKey);
  else task = `ext:${display}`;
  return {
    id: w.session_id,
    task_id: task,
    kind: w.own ? 'code' : 'ext',
    own: w.own,
    target: w.target,
    display_session: display,
    agent: agentName(w.target),
    title: w.title ?? (w.cwd ? sessionName(w.cwd) : agentName(w.target)),
    state: (SESSION_STATES.has(w.state) ? w.state : IDLE_STATES.has(w.state) ? 'idle' : 'running') as SessionState,
    since: secToMs(w.updated_at),
    cwd: w.cwd ?? '',
    last_line: w.last_line,
  };
}

/** Goal with the tasks whose rows carry its goal_id. */
export function fromGoal(row: WireGoal, tasks: readonly Task[]): Goal {
  return {
    id: row.goal_id,
    title: row.title,
    status: row.state,
    revision: row.revision,
    created_at: secToMs(row.created_at),
    updated_at: secToMs(row.updated_at),
    task_ids: tasks.filter((t) => t.goal_id === row.goal_id).map((t) => t.id),
    note: row.objective,
  };
}
