import type { WireEpisode, WireFact, WireTurn } from '../domain/wire';
import { isoWithOffset } from '../domain/units';
import type { MockResponse, MockRoute } from './types';
import { CHARACTER, E3, F1 } from './fixtures/ids';
import {
  MINUTE,
  NOW,
  WIRE_ATTENTION_APP,
  WIRE_ATTENTION_DOMAIN,
  WIRE_BROWSER,
  WIRE_CONVERSATIONS,
  WIRE_EPISODES,
  WIRE_FACTS,
  WIRE_HISTORY,
  WIRE_MEMORY_PAUSED,
  isoAt,
} from './fixtures';
import { V31_FACTS, V31_RUNS, V31_SPARSE_FACTS, V31_SPARSE_RUNS, v31RunDetail } from './memory-v31';

// Memory page endpoints in agentd's shapes (server.py, memory.py, history.py, ca/task_understanding*.py). Writes change
// this module's copy, so a demo shows what it just did; a reload starts from the fixtures again.

/** Demo pause: observation paused for another 18 minutes. */
export const DEMO_PAUSED_UNTIL = NOW + 18 * MINUTE;

const NOW_S = NOW / 1000;
const TODAY = '2026-10-29';
const KINDS = ['fact', 'preference', 'experience', 'agreement', 'name', 'birthday'];
const ACTIVITIES = ['editing_code', 'build_failed', 'comparing_sources', 'watching_video', 'waiting_approval', 'typing', 'away', 'unreadable', 'reading', 'meeting', 'gaming', 'switching'];
const CLEARABLE = ['view', 'window_text', 'page', 'selection'];

const ok = (body: unknown, status = 200): MockResponse => ({ status, body });
const bad = (error: string, status = 400, extra: object = {}): MockResponse => ({ status, body: { error, ...extra } });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null);

/** `GET /memory/runs` rows of both purposes, newest first (ca/memory_service.py list()); memory_extract ends committed or no_new_knowledge. */
const RUNS = (
  [
    ['memory_extract', 'committed'],
    ['conversation', 'completed'],
    ['memory_extract', 'no_new_knowledge'],
    ['conversation', 'failed'],
    ['memory_extract', 'committed'],
    ['conversation', 'completed'],
    ['conversation', 'cancelled'],
    ['memory_extract', 'no_new_knowledge'],
    ['conversation', 'completed'],
    ['memory_extract', 'committed'],
  ] as const
).map(([purpose, state], i) => ({
  run_id: `mrun-${String(i).padStart(2, '0')}`,
  backend: 'codex',
  model: 'gpt-5-mini',
  character_id: CHARACTER,
  started_at: NOW_S - (i + 1) * 1800,
  finished_at: NOW_S - (i + 1) * 1800 + 42,
  state,
  prompt_version: `${purpose}-v2`,
  redacted_reason: null,
}));

/** The memory journal keys an `agent_run:` evidence ref by the chat line it read (integration.py), not by a task's run id. */
const EXTRACT_RUN = 'turn-305';
const TASK_RUN_REF = 'agent_run:run-8d03';

/** Detail kept for a run (memory_service.py `get`): the failed and cancelled ones are past the 48 h window. */
function runDetail(id: string) {
  const extract = id === EXTRACT_RUN;
  const run = extract ? { ...RUNS[0]!, run_id: id } : RUNS.find((r) => r.run_id === id);
  if (!run) return null;
  const gone = run.state === 'failed' || run.state === 'cancelled';
  const said = run.prompt_version.startsWith('conversation') ? '按项目分组，不要按日期。' : '';
  const proposals =
    run.state === 'no_new_knowledge'
      ? []
      : extract
        ? [{ proposal: { operation: 'add', text: '周报按项目分组', evidence_quote: '按项目分组，不要按日期。' }, receipt: { outcome: 'candidate', fact_id: F1, version: 1 } }]
        : [{ proposal: { operation: 'add', text: '按项目分组', evidence_quote: '按项目分组' }, receipt: { outcome: 'stored', fact_id: 'f0run', version: 1 } }];
  return {
    ...run,
    input_sha256: 'a3f1c9',
    detail: gone ? null : { user_input: said, request: said ? JSON.stringify({ user: said, facts: [] }) : '', request_truncated: false, proposals, output: said ? '好，我按目录把提交归到 4 个项目里重写。' : null },
    redacted_reason: gone ? 'expired' : null,
    events: [
      { seq: 1, at: run.started_at + 1, event: 'context', mode: 'memory', references: [] },
      ...proposals.map((p, i) => ({ seq: i + 2, at: run.started_at + 20, event: 'proposal', operation: 'add', outcome: p.receipt.outcome, reason: null })),
    ],
  };
}

/** `GET /episodes/{id}/evidence` (server.py `_episode_evidence`, character kernel): the source items the run read, each as JSON, and its receipt. */
function evidenceOf(e: WireEpisode) {
  const items: Array<Record<string, unknown> & { kind: string }> =
    e.id === E3
      ? [
          { source_id: 'history:turn-301', user: 'HostLink 又断了，帮我看看日志。', assistant: '我先翻一下最近的心跳日志。', verified: false, kind: 'conversation', requires: [] },
          { source_id: 'job:job-hl1', user: '把 HostLink 断线前后的日志整理一份给我', content: { task_id: 'task-hl1', recovered: false, validation: { ok: true } }, verified: true, kind: 'role_task', requires: [] },
        ]
      : [];
  return {
    header: ['角色内核生成；用户原话、助手声明和检查证据分别标注。'],
    lines: items.map((item, i) => ({ n: i + 1, tag: item.kind, text: JSON.stringify(item) })),
    run: { backend: 'claude_agent_sdk', model: 'claude-haiku-4-5', attempt: 1, duration_ms: 6400, outcome: 'committed', reasons: [] },
  };
}

/** `GET /episodes?date=` threads for the fixture day. */
const THREADS = [
  { session: 'HostLink 断线重连', yours_minutes: 95, agent_minutes: 40, status: 'ongoing', progress: '定位到心跳超时' },
  { session: '周报', yours_minutes: 30, agent_minutes: 12, status: 'needs_you', progress: '待确认分组' },
  { session: 'Metal 帧率', yours_minutes: 45, agent_minutes: 0, status: 'done', progress: null },
];

/** Two of the history rows belong to the first conversation, so「打开所属对话」has somewhere to go. */
const HISTORY: WireTurn[] = WIRE_HISTORY.map((t, i) => (i < 2 ? { ...t, conversation_id: WIRE_CONVERSATIONS[0]?.id ?? null } : t));

/** The memory page's own demos (`#/memory…`) read the prototype set; ⌘K on other pages and unit tests keep the shared fixtures. */
type SetKey = 'base' | 'v31' | 'sparse';
const setKey = (): SetKey => {
  const hash = globalThis.location?.hash ?? '';
  return !/^#\/memory(?:[?/]|$)/.test(hash) ? 'base' : /[?&]demo=sparse(?:&|$)/.test(hash) ? 'sparse' : 'v31';
};
const store: Record<SetKey, WireFact[]> = {
  base: WIRE_FACTS.map((f) => ({ ...f, evidence: f.evidence.map((ref) => (ref === TASK_RUN_REF ? `agent_run:${EXTRACT_RUN}` : ref)) })),
  v31: V31_FACTS.map((f) => ({ ...f })),
  sparse: V31_SPARSE_FACTS.map((f) => ({ ...f })),
};
const facts = () => store[setKey()];
const setFacts = (next: WireFact[]) => void (store[setKey()] = next);
/** server.py `_memory_read`: active facts, then candidates, with state on every row. */
const wireFacts = (rows: WireFact[]): WireFact[] => [
  ...rows.filter((f) => f.state !== 'candidate'),
  ...rows.filter((f) => f.state === 'candidate'),
];
export let paused = WIRE_MEMORY_PAUSED;
let historyCleared = false;
let newIds = 0;
/** The user was away while the full test run went (the fixture's 12:00–13:10 afk span). */
const AWAY_EPISODE: WireEpisode = { id: Math.max(...WIRE_EPISODES.map((e) => e.id)) + 1, start: isoAt(12, 10), end: isoAt(13, 5), created_at: isoAt(13, 5), title: '终端跑完整测试', apps: ['Terminal'] };
/** The rest of a v2 row of episodes.py `day()`, for fields the fixtures leave out. */
const EPISODE_ROW = { hosts: [], threads: [], open_questions: [], user_actions: [], agent_actions: [], version: 2, run_id: null, edited: false, outcome: 'committed', titles: [], typed: false };
/** Episodes after the away one came from memory_pipeline.py, which writes presence 'unknown'. */
const presenceOf = (e: WireEpisode) => (e === AWAY_EPISODE ? 'away' : e.start > AWAY_EPISODE.start ? 'unknown' : 'present');
const episodes: WireEpisode[] = [...WIRE_EPISODES, AWAY_EPISODE]
  .sort((a, b) => a.start.localeCompare(b.start))
  .map((e) => ({ ...EPISODE_ROW, ...e, description: `${e.title}（${(e.apps ?? []).join('、')}）`, presence: presenceOf(e), threads: [{ session: e.title,
    status: 'unknown', progress: '', topic: e.title, blocked: false, evidence: [], source_ids: [], subject: null, goal: null, constraints: [], decisions: [], outcome: null, unresolved: [], next_steps: [], requires: [], scope_ids: [] }] }));
const hypotheses = [
  {
    id: 'hyp-7c1e2a9b4d6f4e0a8b3c5d7e9f1a2b3c',
    revision: 1,
    state: 'active',
    created_at: NOW_S - 600,
    expires_at: NOW_S + 3000,
    task: '在修 HostLink 断线重连', goal: '角色断线后自动恢复',
    next_step: '跑 swift test 看心跳用例',
    status: 'working', confidence: 0.6, evidence: [], authority: 'inferred_hypothesis', character_id: CHARACTER, conversation_id: null,
    consent_epoch: 1, source: 'activity_summary', producer: 'character_semantic', source_refs: [], semantic_run_id: 'semantic-fixture',
  },
];

/** memory.py `_records`: no owner reads every fact, `shared` the ones private to nobody, a character id hers. */
const ownedBy = (owner: string | null) => facts().filter((f) => owner === null || f.owner === (owner === 'shared' ? null : owner));

const counts = (rows: WireFact[]) => {
  const out: Record<string, number> = { asserted_by_user: 0, confirmed_by_user: 0, observed_context: 0, inferred_hypothesis: 0 };
  for (const f of rows) out[f.source] = (out[f.source] ?? 0) + 1;
  return out;
};

/** memory.py `_revise`: version check, then the new version (touched by the user, so observed and inferred become confirmed). */
function revise(id: string | undefined, body: unknown, newText?: string): MockResponse {
  const b = obj(body);
  if (!isInt(b.expected_version)) return bad('expected_version_required');
  const f = facts().find((x) => x.fact_id === id);
  if (!f) return bad('unknown_fact', 404);
  if (f.version !== b.expected_version) return bad('version_conflict', 409, { current_version: f.version });
  const touched = newText === undefined || f.source === 'observed_context' || f.source === 'inferred_hypothesis';
  Object.assign(f, { version: f.version + 1, state: 'active', ...(touched ? { source: 'confirmed_by_user' } : {}), ...(newText !== undefined ? { text: newText } : {}) });
  return ok({ version: f.version });
}

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/memory',
    handler: ({ query }) => {
      const rows = ownedBy(query.get('owner'));
      return ok({ paused, facts: wireFacts(rows), counts: counts(rows) });
    },
  },
  {
    method: 'PUT',
    path: '/memory/paused',
    handler: ({ body }) => {
      const p = obj(body).paused;
      if (typeof p !== 'boolean') return bad('invalid_payload');
      paused = p;
      return ok({ paused });
    },
  },
  {
    method: 'POST',
    path: '/memory/facts',
    handler: ({ body }) => {
      const b = obj(body);
      const t = text(b.text, 500);
      if (t == null) return bad('invalid_text');
      const kind = b.kind ?? 'fact';
      if (typeof kind !== 'string' || !KINDS.includes(kind)) return bad('invalid_kind');
      const same = facts().find((f) => f.text === t);
      if (same) return ok({ fact_id: same.fact_id, reinforced: true });
      newIds += 1;
      const fact_id = `f0new${String(newIds).padStart(27, '0')}`;
      const source = kind === 'name' || kind === 'birthday' ? 'confirmed_by_user' : 'asserted_by_user';
      setFacts([{ fact_id, version: 1, owner: null, kind, text: t, source, state: 'active', evidence: [], recorded_at: NOW_S, last_used_at: null, score: 0, uses_today: 0, last_injected_at: null, last_mentioned_at: null, recent_uses: [], stale: false, occurred_at: null }, ...facts()]);
      return ok({ fact_id }, 201);
    },
  },
  { method: 'POST', path: '/memory/facts/:id/confirm', handler: ({ params, body }) => revise(params.id, body) },
  {
    method: 'POST', path: '/memory/facts/:id/reject',
    handler: ({ params, body }) => {
      const v = obj(body).expected_version, f = facts().find((x) => x.fact_id === params.id && x.state === 'candidate');
      if (!isInt(v)) return bad('expected_version_required');
      if (!f) return bad('unknown_fact', 404);
      if (f.version !== v) return bad('version_conflict', 409, { current_version: f.version });
      setFacts(facts().filter((x) => x !== f));
      return ok({ rejected: true });
    },
  },
  {
    method: 'PATCH',
    path: '/memory/facts/:id',
    handler: ({ params, body }) => {
      const t = text(obj(body).text, 500);
      return t == null ? bad('invalid_text') : revise(params.id, body, t);
    },
  },
  {
    method: 'DELETE',
    path: '/memory/facts/:id',
    handler: ({ params, query }) => {
      const v = Number(query.get('expected_version') ?? 'x');
      if (!Number.isInteger(v)) return bad('expected_version_required');
      const f = facts().find((x) => x.fact_id === params.id);
      if (!f) return bad('unknown_fact', 404);
      if (f.version !== v) return bad('version_conflict', 409, { current_version: f.version });
      setFacts(facts().filter((x) => x !== f));
      return ok({ deleted: true });
    },
  },
  {
    method: 'DELETE',
    path: '/memory',
    handler: ({ query }) => {
      const scope = query.get('scope');
      if (scope !== 'facts' && scope !== 'history' && scope !== 'all') return bad('invalid_scope');
      const before = facts().length;
      if (scope !== 'history') setFacts(scope === 'all' ? [] : facts().filter((f) => f.kind === 'name' || f.kind === 'birthday'));
      const history = scope === 'facts' || historyCleared ? 0 : HISTORY.length;
      historyCleared ||= scope !== 'facts';
      return ok({ facts_deleted: before - facts().length, history_deleted: history });
    },
  },
  {
    method: 'GET',
    path: '/memory/runs',
    handler: ({ query }) => {
      const limit = Number(query.get('limit') ?? '50');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad('invalid_limit');
      return ok({ runs: { base: RUNS, v31: V31_RUNS, sparse: V31_SPARSE_RUNS }[setKey()].slice(0, limit) });
    },
  },
  {
    method: 'GET',
    path: '/memory/runs/:id',
    handler: ({ params }) => {
      const run = runDetail(params.id ?? '') ?? v31RunDetail(params.id ?? '');
      return run ? ok(run) : bad('unknown_memory_run', 404);
    },
  },
  {
    method: 'GET',
    path: '/history',
    handler: ({ query }) => {
      const limit = Number(query.get('limit') ?? '50');
      const before = query.get('before');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (before != null && !Number.isInteger(Number(before)))) return bad('invalid_cursor');
      const rows = (historyCleared ? [] : HISTORY).filter((t) => before == null || t.id < Number(before));
      return ok({ turns: rows.slice(0, limit), next: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null });
    },
  },
  {
    method: 'GET',
    path: '/episodes',
    handler: ({ query }) => {
      const date = query.get('date') ?? TODAY;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad('invalid_date');
      const today = date === TODAY;
      return ok({ date, enabled: true, episodes: today ? episodes : [], threads: today ? THREADS : [] });
    },
  },
  {
    method: 'PATCH',
    path: '/episodes/:id',
    handler: ({ params, body }) => {
      const e = episodes.find((x) => String(x.id) === params.id);
      if (!e) return bad('unknown_episode', 404);
      const b = obj(body);
      const title = text(b.title, 120);
      const description = text(b.description, 12_000);
      if (title == null) return bad('invalid_title');
      if (description == null) return bad('invalid_description');
      Object.assign(e, { title, description, edited: true });
      return ok({ episode: e });
    },
  },
  {
    method: 'DELETE',
    path: '/episodes/:id',
    handler: ({ params }) => {
      const i = episodes.findIndex((x) => String(x.id) === params.id);
      if (i < 0) return bad('unknown_episode', 404);
      episodes.splice(i, 1);
      // server.py `_forget_derived`: the facts this episode is evidence of go with it.
      const before = facts().length;
      setFacts(facts().filter((f) => !f.evidence.some((ref) => ref.startsWith(`episode:${params.id}@`))));
      return ok({ deleted: 1, facts: before - facts().length });
    },
  },
  {
    method: 'GET',
    path: '/episodes/:id/evidence',
    handler: ({ params }) => {
      const e = episodes.find((x) => String(x.id) === params.id);
      return e ? ok(evidenceOf(e)) : bad('unknown_episode', 404);
    },
  },
  {
    method: 'GET',
    path: '/attention/summary',
    handler: ({ query }) => {
      const by = query.get('by') ?? 'app';
      if (by !== 'app' && by !== 'domain' && by !== 'title') return bad('invalid_by');
      return ok(by === 'domain' ? WIRE_ATTENTION_DOMAIN : WIRE_ATTENTION_APP);
    },
  },
  { method: 'GET', path: '/attention/browser', handler: () => ok(WIRE_BROWSER) },
  {
    method: 'GET',
    path: '/task-understanding',
    handler: () =>
      ok({ available: true, reason: null, character_id: CHARACTER, consent_epoch: 1, version: 'tu-1', hypotheses: hypotheses.filter((h) => h.state === 'active'),
        segments: [], authority: 'inferred_hypothesis', not_user_authorization: true, task_corrections: {}, uncertainties: [] }),
  },
  {
    method: 'POST',
    path: '/task-understanding/:id/correct',
    handler: ({ params, body }) => {
      const b = obj(body);
      if (!isInt(b.revision) || (b.action !== 'reject' && b.action !== 'correct')) return bad('invalid_payload');
      const h = hypotheses.find((x) => x.id === params.id && x.state === 'active');
      if (!h || h.revision !== b.revision) return bad('task_hypothesis_changed', 409);
      Object.assign(h, { revision: h.revision + 1, state: b.action === 'reject' ? 'rejected' : 'corrected' });
      return ok(h);
    },
  },
  {
    method: 'PUT',
    path: '/context/activity',
    handler: ({ body }) => {
      const b = obj(body);
      if ('activity' in b && b.activity === null) return ok({ activity: null, until: null, focus_id: null, cancelled_line: null });
      const minutes = b.minutes;
      if (typeof b.activity !== 'string' || !ACTIVITIES.includes(b.activity) || !isInt(minutes) || minutes < 1 || minutes > 240) return bad('invalid_payload');
      return ok({ activity: b.activity, until: isoWithOffset(NOW + minutes * MINUTE), focus_id: null, cancelled_line: null });
    },
  },
  {
    method: 'DELETE',
    path: '/context/items/:type',
    handler: ({ params }) => (CLEARABLE.includes(params.type ?? '') ? ok({ type: params.type, cleared: true, cancelled_line: null }) : bad('invalid_type')),
  },
];
