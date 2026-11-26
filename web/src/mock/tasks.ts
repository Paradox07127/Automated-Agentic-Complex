import type { WireDelivery, WireLedgerTask, WireRun, WireRunItem, WireTaskRow } from '../domain';
import {
  atS,
  FILE_EFFECTS,
  NOW,
  TASKS,
  WIRE_DELIVERIES,
  WIRE_GOALS,
  WIRE_INTERACTIONS,
  WIRE_ITEMS,
  WIRE_LEDGER,
  WIRE_RUNS,
  WIRE_SESSIONS,
  WIRE_STEPS,
  WIRE_TASK_ROWS,
} from './fixtures';
import { CODE_FAILED, CODE_REVIEW, S_C07A, T1, T3, T4, T6 } from './fixtures/ids';
import type { MockRoute, MockResponse } from './types';

// Task page endpoints in agentd's shapes (http.py, deliveries.py, server.py). `?fail=…` selects an error demo; the page
// only adds it under the fake bridge.

const NOW_S = NOW / 1000;
const ok = (body: unknown, status = 200): MockResponse => ({ status, body });
const bad = (error: string, status = 400): MockResponse => ({ status, body: { error } });
const obj = (b: unknown): Record<string, unknown> => (b != null && typeof b === 'object' ? (b as Record<string, unknown>) : {});

/** own.py `manage`: PUT/DELETE /sessions/<own id> with {expected_version, …}; the fixture row is not changed, so every demo write starts from revision 1. */
function manageSession(id: string, body: unknown, del: boolean): MockResponse {
  const s = WIRE_SESSIONS.find((x) => x.own && x.session_id === id);
  if (!s) return bad('unknown_session', 404);
  const b = obj(body);
  if (typeof b.expected_version !== 'number' || !Number.isInteger(b.expected_version)) return bad('invalid_session_update');
  if (b.expected_version !== s.revision) return bad('version_conflict', 409);
  const allowed = del ? ['expected_version'] : ['expected_version', 'title', 'pinned', 'archived'];
  if (Object.keys(b).some((k) => !allowed.includes(k)) || (!del && Object.keys(b).length < 2)) return bad('invalid_session_update');
  if (['pinned', 'archived'].some((k) => k in b && typeof b[k] !== 'boolean')) return bad('invalid_session_update');
  if ('title' in b && (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 80)) return bad('invalid_title');
  if (del) return ok({ deleted: true });
  const { expected_version: _v, ...fields } = b;
  return ok({ ...s, ...fields, ...(typeof b.title === 'string' ? { title: b.title.trim() } : {}), revision: (s.revision ?? 0) + 1 });
}
/** True when `b` has exactly these keys (agentd's `set(body) != {...}` checks). */
const keysAre = (b: unknown, ...keys: string[]) => {
  const k = Object.keys(obj(b)).sort();
  return k.length === keys.length && [...keys].sort().every((x, i) => x === k[i]);
};
const hex32 = (n: number) => n.toString(16).padStart(32, '0');

/** Delivery decision failure codes (deliveries.py:276-283). */

/** What `result` a finished task run stores (store.py finish: `{error, failure}` or verify_run's checks). */
const RESULTS: Record<string, unknown> = {
  'run-0f11': { error: 'scope_revoked', failure: { code: 'unknown', retryable: false, public_message: '本次请求失败，请稍后再试。' } },
  'run-5b20': { ok: true, self_checked: true, artifacts: [], checks: [{ check: 'required_artifact', ok: true }, { check: 'artifact_verified', ok: true }, { check: 'effects_reconciled', ok: true }] },
  'run-71a2': { ok: true, self_checked: true, artifacts: [], checks: [{ check: 'required_artifact', ok: true }, { check: 'artifact_verified', ok: true }] },
};
const RUNS: WireRun[] = WIRE_RUNS.map((r) => (RESULTS[r.run_id] ? { ...r, result: RESULTS[r.run_id] } : r));

/** The plan item a run keeps (runtime.py plan sink): the steps the fixtures' tasks show. */
const PLAN_RUN: Record<string, string> = { [T1]: 'run-8d03', [T3]: 'run-9c1e', [T4]: 'run-5b20', [T6]: 'run-0f11' };
function planItem(taskId: string, runId: string): WireRunItem | null {
  const steps = (TASKS.find((t) => t.id === taskId)?.steps ?? []).map((s) => ({ text: s.text, status: s.status }));
  const run = RUNS.find((r) => r.run_id === runId);
  if (steps.length === 0 || !run) return null;
  const status = steps.every((s) => s.status === 'completed') ? 'completed' : 'in_progress';
  const text = steps.map((s) => s.text).join('\n');
  // runtime.py numbers items from 1; the plan takes the next seq when it is first published.
  const seq = (WIRE_ITEMS[runId]?.length ?? 0) + 1;
  return { run_id: runId, item_id: `${runId}:plan`, seq, kind: 'plan', phase: null, status, name: null, summary: text.slice(0, 200), text: '', parent_item_id: null, created_at: run.started_at, updated_at: run.ended_at ?? NOW_S, steps };
}
const itemsOf = (runId: string): WireRunItem[] | null => {
  if (!RUNS.some((r) => r.run_id === runId)) return null;
  const task = Object.keys(PLAN_RUN).find((k) => PLAN_RUN[k] === runId);
  const plan = task ? planItem(task, runId) : null;
  return [...(WIRE_ITEMS[runId] ?? []), ...(plan ? [plan] : [])];
};

const rowOf = (cid: string) => WIRE_TASK_ROWS.find((r) => r.canonical_task_id === cid) ?? null;

export { CODE_FAILED, CODE_REVIEW };
const CODE_LEDGER: WireLedgerTask[] = [
  {
    task_id: CODE_REVIEW.slice('task:'.length),
    target: 'codex',
    cwd: '/Users/me/Endfield/app',
    title: '给快速输入加「这一轮不记」开关',
    mode: 'workspace_write',
    state: 'needs_review',
    verify_cmd: null,
    session_id: null,
    created_at: atS(13, 40),
    updated_at: atS(13, 58),
    result: { exit_code: null, output_tail: null, reason: 'no_verify_cmd', delivery_id: 'delivery-d439477959f613d1dcc65d3caa7701ac' },
    requested_by: null,
  },
  {
    task_id: CODE_FAILED.slice('task:'.length),
    target: 'claude',
    cwd: '/Users/me/Endfield/app',
    title: '修 Supervisor 端口冲突重试',
    mode: 'workspace_write',
    state: 'failed',
    verify_cmd: 'swift test --filter SupervisorTests',
    session_id: null,
    created_at: atS(11, 20),
    updated_at: atS(11, 41),
    requested_by: null,
    result: {
      exit_code: 1,
      output_tail: [
        "Test Suite 'SupervisorTests' started",
        "Test Case 'SupervisorTests.testPortInUseRetries' started",
        'SupervisorTests.swift:212: error: XCTAssertEqual failed: ("2") is not equal to ("3")',
        "Test Case 'SupervisorTests.testPortInUseRetries' failed (0.412 seconds)",
        'Executed 14 tests, with 1 failure (0 unexpected) in 3.208 seconds',
      ].join('\n'),
      reason: null,
      delivery_id: 'delivery-516d123071c5ed9ba2a6645937a14fed',
    },
  },
];
/** The ledger rows as `/agent/tasks` lists them (deliveries.py `_canonical`). */
const CODE_ROWS: WireTaskRow[] = CODE_LEDGER.map((l) => ({
  canonical_task_id: `task:${l.task_id}`,
  task_id: l.task_id,
  job_id: null,
  goal_id: null,
  run_id: null,
  source_run_id: null,
  parent_run_id: null,
  conversation_id: null,
  character_id: null,
  generation: 0,
  title: l.title,
  state: l.state,
  created_at: l.created_at,
  updated_at: l.updated_at,
  delivery: null,
  revision: 0,
  verification_source: null,
  redacted: false,
}));
const codeDemo = (query: URLSearchParams) => query.get('demo') === 'code-review';

/** jobs.py job_record without the private payload, as POST /agent/jobs and the resume routes return it. */
function jobRecord(jobId: string, title: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const row = WIRE_TASK_ROWS.find((r) => r.job_id === jobId);
  return {
    job_id: jobId,
    goal_id: row?.goal_id ?? null,
    title: row?.title ?? title,
    state: 'queued',
    run_id: `bg-${hex32(NOW + 2)}`,
    previous_run_id: row?.run_id ?? null,
    result: null,
    created_at: row?.created_at ?? NOW_S,
    updated_at: NOW_S,
    conversation_id: row?.conversation_id ?? null,
    source_turn_id: null,
    generation: row ? row.generation + 1 : 0,
    ...over,
  };
}

/** Coding session transcript (own.py lines). */
const LINES: Record<string, string[]> = {
  [S_C07A]: ['读取 Sources/CompanionCore/HostLink.swift', '运行 swift test --filter HostLinkTests（42 通过，1 失败）', '修改 reconnect()：心跳超时从 1.5 s 放宽到 3 s', '待批准：修改 HostLink.swift、运行 swift test'],
};

function decide(action: 'accept' | 'reject'): MockRoute['handler'] {
  return ({ params, query, body }) => {
    const code = query.get('fail');
    if (code) return bad(code, 409);
    if (!keysAre(body, 'expected_revision', 'generation', 'delivery_id')) return bad('invalid_delivery_payload');
    const row = rowOf(params.id ?? '');
    if (!row) return bad('unknown_task', 404);
    const b = obj(body);
    const d = WIRE_DELIVERIES.find((x) => x.delivery_id === b.delivery_id);
    if (!d) return bad('unknown_delivery', 404);
    if (d.revision !== b.expected_revision || d.generation !== b.generation) return bad('delivery_version_changed', 409);
    const state = action === 'accept' ? 'accepted' : 'rejected';
    const delivery: WireDelivery = { ...d, state, revision: d.revision + 1, decided_at: NOW_S, decision_source: 'user' };
    return ok({ task: { ...row, state, delivery, revision: delivery.revision }, delivery });
  };
}

function receipt(kind: 'presented' | 'viewed'): MockRoute['handler'] {
  return ({ params, body }) => {
    if (!keysAre(body, 'expected_revision', 'generation')) return bad('invalid_delivery_payload');
    const d = WIRE_DELIVERIES.find((x) => x.delivery_id === params.id);
    if (!d) return bad('unknown_delivery', 404);
    const b = obj(body);
    const field = kind === 'presented' ? 'presented_at' : 'viewed_at';
    if (d[field] != null) return ok({ delivery: d });
    const state = d.state === 'accepted' || d.state === 'rejected' ? d.state : kind === 'viewed' || d.viewed_at != null ? 'viewed' : 'presented';
    return ok({ delivery: { ...d, [field]: NOW_S, state, revision: Number(b.expected_revision) + 1 } });
  };
}

/** deliveries.py opened: the artifact's first opened_at; the revision stays. */
const opened: MockRoute['handler'] = ({ params, body }) => {
  if (!keysAre(body, 'artifact_id') || typeof obj(body).artifact_id !== 'string') return bad('invalid_delivery_payload');
  const d = WIRE_DELIVERIES.find((x) => x.delivery_id === params.id);
  if (!d) return bad('unknown_delivery', 404);
  if (d.redacted) return bad('delivery_revoked', 409);
  const id = obj(body).artifact_id;
  if (!d.artifacts.some((a) => a.artifact_id === id)) return bad('unknown_artifact', 404);
  return ok({ delivery: { ...d, artifacts: d.artifacts.map((a) => (a.artifact_id === id ? { ...a, opened_at: a.opened_at ?? NOW_S } : a)) } });
};

export const routes: MockRoute[] = [
  // The reads behind loadTasksBase (deliveries.py tasks_page, tasks.py, http.py).
  { method: 'GET', path: '/agent/tasks', handler: ({ query }) => (query.get('fail') ? bad('not_found', 404) : ok({ tasks: codeDemo(query) ? [...WIRE_TASK_ROWS, ...CODE_ROWS] : WIRE_TASK_ROWS, next_cursor: null })) },
  { method: 'GET', path: '/agent/deliveries', handler: () => ok({ deliveries: WIRE_DELIVERIES, next_cursor: null }) },
  { method: 'GET', path: '/tasks', handler: ({ query }) => ok({ tasks: codeDemo(query) ? [...WIRE_LEDGER, ...CODE_LEDGER] : WIRE_LEDGER }) },
  { method: 'GET', path: '/agent/interactions', handler: () => ok({ requests: WIRE_INTERACTIONS }) },
  { method: 'GET', path: '/agent/goals', handler: () => ok({ goals: WIRE_GOALS }) },
  {
    method: 'GET',
    path: '/agent/jobs',
    handler: () => ok({ jobs: WIRE_TASK_ROWS.flatMap((r) => (r.job_id ? [jobRecord(r.job_id, r.title, { state: r.state, run_id: r.run_id, previous_run_id: null, updated_at: r.updated_at, source_turn_id: r.source_run_id, generation: r.generation })] : [])) }),
  },
  { method: 'GET', path: '/agent/runs', handler: ({ query }) => ok({ runs: query.has('run_id') ? RUNS.filter((r) => query.getAll('run_id').includes(r.run_id)) : RUNS }) },
  {
    method: 'GET',
    path: '/agent/tasks/:id/steps',
    handler: ({ params, query }) => {
      if (query.get('fail') || !rowOf(params.id ?? '')) return bad('unknown_task', 404);
      return ok({ steps: WIRE_STEPS[params.id ?? ''] ?? [], next_cursor: null });
    },
  },
  {
    method: 'GET',
    path: '/agent/tasks/:id/files',
    handler: ({ params }) => {
      const row = rowOf(params.id ?? '');
      if (!row) return bad('not_found', 404);
      const files = (FILE_EFFECTS[row.canonical_task_id] ?? []).map((f) => ({ path: f.path.replace(/^~\//, '/Users/me/'), op: f.op, added: f.added ?? null, removed: f.removed ?? null, run_id: row.run_id }));
      return ok({ files: files.sort((a, b) => a.path.localeCompare(b.path)) });
    },
  },
  {
    method: 'GET',
    path: '/agent/runs/:id/items',
    handler: ({ params }) => {
      const items = itemsOf(params.id ?? '');
      return items ? ok({ items }) : bad('unknown_run', 404);
    },
  },
  {
    method: 'GET',
    path: '/sessions/:id/lines',
    handler: ({ params, query }) => {
      const all = (LINES[params.id ?? ''] ?? []).map((text, i) => ({ seq: i + 1, role: 'assistant', text, ts: atS(14, 20 + i * 3) }));
      const after = Number(query.get('after') ?? 0);
      const lines = all.filter((l) => l.seq > after);
      return ok({ lines, next: lines.at(-1)?.seq ?? after });
    },
  },
  { method: 'POST', path: '/agent/tasks/:id/accept', handler: decide('accept') },
  { method: 'POST', path: '/agent/tasks/:id/reject', handler: decide('reject') },
  // server.py _task_review: a coding task that needs review; a character task settles through its delivery.
  ...(['accept', 'reject'] as const).map(
    (verdict): MockRoute => ({
      method: 'POST',
      path: `/tasks/:id/${verdict}`,
      handler: ({ params }) => {
        const l = [...WIRE_LEDGER, ...CODE_LEDGER].find((x) => x.task_id === params.id);
        if (!l) return bad('unknown_task', 404);
        if (l.target === 'character') return bad('delivery_receipt_required', 409);
        if (l.state !== 'needs_review') return bad('invalid_state', 409);
        return ok({ task: { ...l, state: verdict === 'accept' ? 'succeeded' : 'failed', updated_at: NOW_S } });
      },
    }),
  ),
  { method: 'POST', path: '/agent/deliveries/:id/presented', handler: receipt('presented') },
  { method: 'POST', path: '/agent/deliveries/:id/viewed', handler: receipt('viewed') },
  { method: 'POST', path: '/agent/deliveries/:id/opened', handler: opened },
  {
    method: 'POST',
    path: '/approvals/:id/decision',
    handler: ({ body }) => {
      const b = obj(body);
      if (typeof b.generation !== 'number') return { status: 409, body: { ok: false, error: 'generation_mismatch' } };
      return ['allow', 'allow_session', 'deny'].includes(String(b.decision)) ? ok({ ok: true }) : { status: 400, body: { ok: false, error: 'invalid_decision' } };
    },
  },
  {
    method: 'POST',
    path: '/agent/interactions/:id/answer',
    handler: ({ params, body }) => {
      const q = WIRE_INTERACTIONS.find((x) => x.request_id === params.id);
      if (!keysAre(body, 'expected_version', 'answers')) return bad('invalid_interaction');
      if (!q || obj(body).expected_version !== q.revision) return bad('interaction_version_changed', 409);
      return ok({ ...q, state: 'answered', revision: q.revision + 1, answer: { answers: obj(body).answers }, resume_required: false });
    },
  },
  { method: 'POST', path: '/agent/interactions/:id/dismiss', handler: ({ body }) => (keysAre(body, 'expected_version') ? ok({ dismissed: true }) : bad('invalid_interaction')) },
  { method: 'POST', path: '/agent/interactions/:id/continue', handler: ({ body }) => (keysAre(body, 'expected_version') ? ok({ state: 'accepted' }, 202) : bad('invalid_interaction')) },
  {
    method: 'POST',
    path: '/agent/jobs/:id/resume',
    handler: ({ params, body }) => {
      if (!Object.keys(obj(body)).every((k) => k === 'text' || k === 'use_current_backend')) return bad('invalid_payload');
      return WIRE_TASK_ROWS.some((r) => r.job_id === params.id) ? ok(jobRecord(params.id ?? '', ''), 202) : bad('unknown_job');
    },
  },
  {
    method: 'POST',
    path: '/tasks/:id/continue',
    // http.py: a character ledger task its job owns resumes that job; another character task starts a resumed turn (server.say).
    handler: ({ params, body }) => {
      if (!Object.keys(obj(body)).every((k) => k === 'text')) return bad('invalid_payload');
      // A job's run records its ledger id as `character-<run_id>` (store.py).
      const owned = WIRE_TASK_ROWS.find((r) => r.job_id && (r.task_id ?? `character-${r.run_id}`) === params.id);
      if (owned?.job_id) return ok(jobRecord(owned.job_id, ''), 202);
      if (!WIRE_LEDGER.some((l) => l.task_id === params.id && l.target === 'character')) return bad('unknown_character_task', 404);
      return ok({ line_id: '5ay0c0ffee13', generation: 43, run_id: '5ay0c0ffee13', runtime: 'codex' }, 202);
    },
  },
  { method: 'POST', path: '/agent/runs/:id/cancel', handler: ({ params, body }) => (keysAre(body, 'generation') ? ok({ run_id: params.id, cancellation_requested: true }, 202) : bad('invalid_payload')) },
  {
    method: 'POST',
    path: '/agent/jobs',
    handler: ({ body }) => {
      const b = obj(body);
      if (typeof b.title !== 'string' || typeof b.text !== 'string' || Object.keys(b).some((k) => !['title', 'text', 'scope_id', 'expected_outputs', 'goal_id'].includes(k))) return bad('invalid_job');
      return ok(jobRecord(hex32(NOW), String(b.title), { goal_id: b.goal_id ?? null, created_at: NOW_S, previous_run_id: null }), 202);
    },
  },
  {
    method: 'POST',
    path: '/sessions',
    handler: ({ body }) => {
      const b = obj(body);
      if (b.target !== 'claude' && b.target !== 'codex') return { status: 400, body: { error: 'invalid_session', field: 'target' } };
      // The bridge turns the picked handle into the path; agentd then checks it is a directory.
      if (b.cwd == null) return { status: 400, body: { error: 'invalid_session', field: 'cwd' } };
      if (typeof b.prompt !== 'string' || !b.prompt.trim()) return { status: 400, body: { error: 'invalid_session', field: 'prompt' } };
      if (b.mode !== undefined && b.mode !== 'read_only' && b.mode !== 'workspace_write') return bad('unsupported_mode');
      return ok({ session_id: 'own:0f1e2d3c4b5a', state: 'accepted' }, 201);
    },
  },
  { method: 'POST', path: '/sessions/:id/interrupt', handler: () => ok({ state: 'accepted' }, 202) },
  { method: 'PUT', path: '/sessions/:id', handler: ({ params, body }) => manageSession(params.id ?? '', body, false) },
  { method: 'DELETE', path: '/sessions/:id', handler: ({ params, body }) => manageSession(params.id ?? '', body, true) },
  { method: 'POST', path: '/sessions/:id/messages', handler: ({ body }) => (typeof obj(body).text === 'string' && String(obj(body).text).trim() ? ok({ state: 'accepted' }, 202) : bad('invalid_text')) },
  {
    method: 'POST',
    path: '/agent/goals',
    handler: ({ body }) => {
      if (!keysAre(body, 'title', 'objective')) return bad('invalid_goal');
      const b = obj(body);
      return ok({ goal_id: hex32(NOW + 1), title: b.title, objective: b.objective, state: 'active', revision: 1, created_at: NOW_S, updated_at: NOW_S }, 201);
    },
  },
  {
    method: 'POST',
    path: '/agent/goals/:id',
    handler: ({ params, body }) => {
      if (!keysAre(body, 'expected_version', 'state')) return bad('invalid_goal_update');
      const g = WIRE_GOALS.find((x) => x.goal_id === params.id);
      if (!g) return bad('not_found', 404);
      const b = obj(body);
      if (b.expected_version !== g.revision) return bad('goal_version_changed', 409);
      return ok({ ...g, state: b.state, revision: g.revision + 1, updated_at: NOW_S });
    },
  },
];
