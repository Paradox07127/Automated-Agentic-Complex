// Diag page endpoints in agentd's shapes. `state=error` / `state=empty` / `demo=sparse` in the page URL pick the failure, empty and sparse demos.
import type { TurnResult, WireTraceTurn } from '../domain';
import { isoToMs, isoWithOffset } from '../domain/units';
import type { WireDiagState, WireObservationDetail, WireSummaryRun } from '../domain/wire';
import { C1, C2, C3, CHARACTER, E1, E2, S_5E10, S_9A41, S_D0C2 } from './fixtures/ids';
import { C1_TURNS } from './fixtures/chatDemo';
import type { WireCapabilities, WireTraceEvent, WireTurnEvents } from '../pages/diag/wire';
import {
  at,
  DAY,
  isoAt,
  NOW,
  seeded,
  TURN_DOTS,
  TURNS,
  WIRE_CHARACTER_STATE,
  WIRE_DIAG_BUDGET,
  WIRE_DIAG_CONNECTIONS,
  WIRE_DIAG_GATE,
  WIRE_DIAG_HOOKS,
  WIRE_DIAG_TURN,
  WIRE_OBSERVATION,
} from './fixtures';
import { BY_CHANNEL, demoParam, SPARSE_BY_CALL, SPARSE_BY_CHANNEL, SPARSE_TURNS, use } from './diagDemo';
import type { MockRoute } from './types';

const stamp = <T extends object>(block: T, at: string) => ({ ...block, updated_at: at });

/** `GET /diag/state`: the 15 blocks of server.py `diag_state`. */
export const DIAG_STATE: WireDiagState = {
  hooks: stamp(WIRE_DIAG_HOOKS, isoAt(14, 29)),
  turn: stamp(WIRE_DIAG_TURN, WIRE_DIAG_TURN.updated_at ?? isoAt(14, 32, 4)),
  mouth_voice: stamp(
    { mouth: 'busy' as const, voice: 'synthesizing', muted: false, avatar_visible: true, speech_failed: { speech_id: 'sp-tr7', reason: 'unreachable', at: isoAt(14, 31, 5) } },
    isoAt(14, 32, 5),
  ),
  gate: stamp(WIRE_DIAG_GATE, WIRE_DIAG_GATE.updated_at ?? isoAt(14, 31, 2)),
  proactive: stamp(
    { focus: { category: 'coding', dwell_s: 840 }, next_judge_at: isoAt(14, 35), held: null, last_judge: { backend: 'haiku', answers: [{ id: 'want_comment', value: false, prob: 0.9 }], at: isoAt(14, 31, 2) }, misses: 1, factor: 1 },
    isoAt(14, 31, 2),
  ),
  observation: stamp(
    {
      ...WIRE_OBSERVATION,
      policy_epoch: 3,
      pending: [{ request_id: 'b1c2d3e4f5a6', window_id: 4211, mode: 'text', reason: null, waited_ms: 12_000 }],
      recent: [
        { request_id: 'a1a1a1a1a1a1', mode: 'text', state: 'ready', reason: null, at: isoAt(14, 31, 40) },
        { request_id: 'a2a2a2a2a2a2', mode: 'image', state: 'ready', reason: null, at: isoAt(14, 29, 12) },
        { request_id: 'a3a3a3a3a3a3', mode: 'text', state: 'failed', reason: 'timeout', at: isoAt(14, 24, 3) },
        { request_id: 'a4a4a4a4a4a4', mode: 'ocr', state: 'ready', reason: null, at: isoAt(14, 20, 50) },
        { request_id: 'a5a5a5a5a5a5', mode: 'image', state: 'declined', reason: 'blacklisted', at: isoAt(14, 18, 5) },
      ],
    },
    isoAt(14, 31, 58),
  ),
  body: stamp({ activity: 'relax', mood: 'low' }, isoAt(14, 22)),
  sessions: stamp(
    {
      sessions: [
        { display_session: S_5E10, effective_state: 'running_tool', observed_at: isoAt(14, 32), stale: false },
        { display_session: S_9A41, effective_state: 'idle', observed_at: isoAt(14, 10), stale: false },
        { display_session: S_D0C2, effective_state: 'stale', observed_at: isoAt(12, 2), stale: true },
      ],
    },
    isoAt(14, 32),
  ),
  budget: stamp({ ...WIRE_DIAG_BUDGET, ...(WIRE_DIAG_BUDGET.model ? { model: { ...WIRE_DIAG_BUDGET.model, by_channel: BY_CHANNEL } } : {}) }, WIRE_DIAG_BUDGET.updated_at ?? isoAt(14, 32)),
  connections: stamp(WIRE_DIAG_CONNECTIONS, isoAt(14, 31)),
  // server.py `_diag_context`: `sources` is always present.
  context: stamp(
    {
      items: [{ type: 'window_text', observation_id: null, at: isoAt(14, 31, 40), expires_at: isoAt(14, 36, 40), expired: false }],
      window: { app: 'Terminal', title: { len: 18, head: 'endfiel' } },
      page: null,
      selection: null,
      activity: { activity: 'editing_code', confidence: 0.82, corrected: false, until: null, mode: 'coding', state: 'flowing', evidence: ['front_coding'] },
      rejected: null,
      sources: { screenshots: 'connected', window_text: 'connected', page_text: 'not_connected' },
    },
    isoAt(14, 31, 58),
  ),
  behavior: stamp({
    running: [{ behavior_id: 'bh-1', type: 'sit', target: null, since: isoAt(14, 2) }],
    switches: { stay_in_place: false, sit_window_top: true, hold_window_edge: true, fullscreen_give_way: true },
    last_receipt: { behavior_id: 'bh-1', phase: 'running', reason: null, at: isoAt(14, 2) },
    capability_character: CHARACTER,
    capabilities: { sit: null, idle: null, observe: null, climb_window_top: 'motion_missing' },
    unsupported: { climb_window_top: 840 },
  }, isoAt(14, 2)),
  character_state: stamp(WIRE_CHARACTER_STATE, isoAt(14, 22)),
  interaction: stamp({ name: 'balanced', model_every: 180, model_refresh: 900, proactive_speech: true, same_cooldown: 600, random_tick_scale: 1, wander_scale: 1, focus_walk_probability: 0.5 }, isoAt(13, 20)),
  rituals: stamp({ pending: ['water'], today: [{ kind: 'morning', line_id: 'line-morning', at: isoAt(9, 2) }] }, isoAt(9, 2)),
};

/** `GET /capabilities`: the voice is degraded (TTS unreachable); screenshots sharing is off, which is not a problem. */
export const CAPABILITIES: WireCapabilities = {
  items: {
    generation: { state: 'ready', reason: null },
    mouth: { state: 'ready', reason: null },
    voice: { state: 'degraded', reason: 'unreachable' },
    personal_agent: { state: 'configured', reason: null },
    share_window_text: { state: 'configured', reason: null },
    share_page_text: { state: 'unavailable', reason: 'off' },
    share_screenshots: { state: 'unavailable', reason: 'off' },
    share_typed_text: { state: 'unavailable', reason: 'off' },
    share_agent_sessions: { state: 'configured', reason: null },
  },
  at: isoAt(14, 32),
};

const WIRE_RESULT: Record<TurnResult, string> = { ok: 'completed', failed: 'failed', interrupted: 'interrupted', skipped: 'blocked', running: 'open', unknown: 'unknown' };
const SOURCE: Record<string, string> = { 对话: 'text', 语音: 'voice', 主动发言: 'proactive', 观察摘要: 'proactive', 角色运行: 'text' };
const sourceOf = (label: string) => SOURCE[label.split(' · ')[0] ?? label] ?? 'text';
/** Input heads (trace_format.py HEAD_MAX = 8 characters) and lengths of the fixture turns. */
const HEAD: Record<string, [string, number]> = {
  tr0: ['顺便查下这个文件', 22],
  tr1: ['这段为什么慢', 6],
  tr3: ['周报按项目分组', 12],
  tr6: ['停一下', 3],
  tr4: ['周报再改一版', 9],
  tr7: ['帮我看下报错', 14],
  tr8: ['帮我整理这周的提', 28],
};

const C1_IDS = new Set(C1_TURNS.map((t) => t.turn_id));
/** The owning conversation of the list: C1's own turns, then typed or spoken turns today by when each conversation ran. */
function ownerOf(id: string, label: string, t: number): string | null {
  if (C1_IDS.has(id)) return C1;
  if (!['对话', '语音'].includes(label.split(' · ')[0] ?? label) || t < at(9, 0)) return null;
  return t >= at(14, 14) ? C1 : t >= at(10, 0) && t <= at(11, 40) ? C2 : t < at(10, 0) ? C3 : null;
}

const row = (id: string, label: string, started_at: number, result: TurnResult, duration_ms: number): WireTraceTurn => {
  const head = HEAD[id];
  return {
    trace_id: id,
    turn_id: id,
    source: sourceOf(label),
    head: head?.[0] ?? null,
    len: head?.[1] ?? null,
    producers: result === 'ok' || result === 'interrupted' ? ['agentd', 'avatar'] : ['agentd'],
    provider: 'openai', account_label: 'codex_login', model: 'gpt-5.5', error_code: result === 'failed' ? 'model_error' : null,
    started_at: isoWithOffset(started_at),
    result: WIRE_RESULT[result],
    turn_state: result === 'ok' ? 'completed' : result === 'failed' || result === 'interrupted' ? result : null,
    turn_outcome: null,
    duration_ms,
    conversation_id: ownerOf(id, label, started_at),
  };
};

/** 7 days of dots (same generator family as TURN_DOTS). */
const WEEK: WireTraceTurn[] = (() => {
  const rnd = seeded(5);
  const out: WireTraceTurn[] = [];
  for (let i = 0; i < 640; i++) {
    const t = NOW - 7 * DAY + Math.round(rnd() * 7 * DAY);
    const r = rnd();
    const result: TurnResult = r < 0.05 ? 'failed' : r < 0.08 ? 'interrupted' : r < 0.2 ? 'skipped' : 'ok';
    out.push(row(`w${i}`, '对话', t, result, Math.round(10 ** (2.3 + rnd() * 2.2))));
  }
  return out;
})();

/** `/trace/turns` rows, newest first: the fixture turns, the rest of the last 24 h, then the week. */
export const TRACE_TURNS: WireTraceTurn[] = [
  ...TURNS.map((t) => row(t.id, t.source, t.started_at, t.result, t.duration_ms)),
  ...TURN_DOTS.filter((d) => !TURNS.some((t) => t.id === d.id)).map((d) => row(d.id, d.source, d.started_at, d.result, d.duration_ms)),
  ...WEEK.filter((w) => isoToMs(w.started_at) < NOW - DAY),
].sort((a, b) => isoToMs(b.started_at) - isoToMs(a.started_at));

/** `demo=sparse` rows, newest first. */
export const SPARSE_TRACE: WireTraceTurn[] = SPARSE_TURNS.map(([h, m, source, result, duration_ms], i) => ({
  trace_id: `sp${i}`,
  turn_id: `sp${i}`,
  source,
  head: null,
  len: null,
  producers: ['agentd'],
  provider: 'openai', account_label: 'codex_login', model: 'gpt-5.5', error_code: null,
  started_at: isoAt(h, m),
  result,
  turn_state: result === 'completed' || result === 'failed' ? result : null,
  turn_outcome: null,
  duration_ms,
  conversation_id: null,
})).reverse();

/** `demo=sparse`: the diag state with a light day's usage. */
const SPARSE_STATE = (): WireDiagState => {
  const m = WIRE_DIAG_BUDGET.model;
  const calls = Object.values(SPARSE_BY_CALL);
  const sum = (k: 'calls' | 'input_tokens' | 'cache_read_input_tokens' | 'output_tokens') => calls.reduce((a, u) => a + u[k], 0);
  const model = m && { ...m, ...use(sum('calls'), sum('input_tokens'), sum('cache_read_input_tokens'), sum('output_tokens'), 0.06), by_call: SPARSE_BY_CALL, by_channel: SPARSE_BY_CHANNEL };
  return { ...DIAG_STATE, budget: { ...DIAG_STATE.budget, model } };
};

const ev =(r: WireTraceTurn, i: number, kind: string, at: number, attrs: Record<string, unknown> = {}, status = 'ok', duration_ms?: number): WireTraceEvent => ({
  event_id: `${r.trace_id}-e${i}`,
  trace_id: r.trace_id,
  turn_id: r.turn_id,
  kind,
  status,
  t_wall: isoWithOffset(at),
  producer: kind.startsWith('playback.') ? 'avatar' : 'agentd',
  span_id: `${r.trace_id}-s${i}`.padEnd(16, '0').slice(0, 16),
  parent_span_id: null,
  ...(duration_ms != null ? { duration_ms } : {}),
  attrs,
});

/** One turn's events as trace_store.py records them, shaped by its result. */
function eventsOf(r: WireTraceTurn, withText: boolean): WireTraceEvent[] {
  const t0 = isoToMs(r.started_at);
  const d = r.duration_ms;
  const at = (f: number) => t0 + Math.round(d * f);
  const text = r.head != null ? { text: { len: r.len, head: r.head } } : { text: null };
  const out: Array<[string, number, Record<string, unknown>?, string?, number?]> = [['input.received', t0, { source: r.source, ...text }]];
  if (r.result === 'blocked') out.push(['gate.decided', at(1), { kind: 'proactive', level: 'low', speak: false, reason: 'cross_cooldown' }, 'blocked']);
  else {
    out.push(['context.assembled', at(0.05), { items: [] }], ['model.started', at(0.12), { model: 'claude-sonnet-4-5', call: 'character_agent' }]);
    if (r.result === 'failed') out.push(['model.finished', at(1), { model: 'claude-sonnet-4-5', input_tokens: 0, output_tokens: 0, stop_reason: 'timeout' }, 'failed', d - Math.round(d * 0.12)]);
    else if (r.result !== 'open') {
      out.push(
        ['model.first_token', at(0.4)],
        ['model.finished', at(0.6), { model: 'claude-sonnet-4-5', input_tokens: 4200, output_tokens: 180, stop_reason: 'end_turn' }, 'ok', at(0.6) - at(0.12)],
        ['line.parsed', at(0.62), { line_id: r.turn_id, intents: [], target: null, first_sentence_only: false }],
        ['speech.requested', at(0.65), { speech_id: `sp-${r.trace_id}`, line_id: r.turn_id }],
        ['speech.first_audio', at(0.72), { speech_id: `sp-${r.trace_id}` }],
        ['playback.started', at(0.75), { speech_id: `sp-${r.trace_id}` }],
      );
      if (r.result === 'interrupted')
        out.push(
          ['cancel.requested', at(0.95), { by: 'ptt', target: 'speech' }],
          ['playback.interrupted', at(1), { speech_id: `sp-${r.trace_id}`, reason: 'barge_in', planned_ms: 1800 }, 'cancelled'],
        );
      else out.push(['playback.ended', at(1), { speech_id: `sp-${r.trace_id}` }, 'ok', at(1) - at(0.75)]);
    } else out.push(['model.first_token', at(1)]);
  }
  return out.map(([kind, t, attrs, status, dur], i) => {
    const e = ev(r, i, kind, t, attrs, status, dur);
    return withText && kind === 'input.received' && r.head ? { ...e, text: { text: r.head } } : e;
  });
}

const devent = (id: string, trace: string, turn: string | null, kind: string, at: number, attrs: Record<string, unknown>, status = 'ok'): WireTraceEvent => ({
  event_id: id,
  trace_id: trace,
  turn_id: turn,
  kind,
  status,
  t_wall: isoWithOffset(at),
  attrs,
});

/** `/trace/decisions` events, newest first. */
export const DECISIONS: WireTraceEvent[] = [
  devent('d1', 'tr2', 'tr2', 'gate.decided', NOW - 68_000, { kind: 'proactive', level: 'low', speak: false, reason: 'cross_cooldown' }, 'blocked'),
  devent('d2', 'tr2', 'tr2', 'judge.decided', NOW - 69_000, { backend: 'haiku', answers: { speak: 'yes' } }),
  devent('d3', 'tr4', 'tr4', 'dispatch.decided', NOW - 359_000, { request_id: 'rq-4', decision: 'allow' }),
  devent('d4', 'bh-tick', null, 'behavior.ticked', NOW - 1_810_000, { options: ['idle', 'fidget'], chosen: 'fidget', reason: null }),
  devent('d5', 'ap-2', null, 'approval.opened', NOW - 420_000, { approval_id: 'ap-2', tool: 'Bash' }),
  devent('d6', 'ap-1', null, 'approval.decided', NOW - 1_500_000, { approval_id: 'ap-1', tool: 'Edit', decision: 'allow' }),
  devent('d7', 'ap-1', null, 'approval.opened', NOW - 1_520_000, { approval_id: 'ap-1', tool: 'Edit' }),
  devent('d8', 'rq-3', null, 'dispatch.proposed', NOW - 2_400_000, { request_id: 'rq-3' }),
];

/** `GET /trace/turns/{id}`: the turn's events plus the decisions on its trace, in time order; null for an unknown trace. */
export function turnEvents(id: string, withText = false): WireTurnEvents | null {
  const r = TRACE_TURNS.find((x) => x.trace_id === id) ?? SPARSE_TRACE.find((x) => x.trace_id === id);
  const events = [...(r ? eventsOf(r, withText) : []), ...DECISIONS.filter((e) => e.trace_id === id)].sort((a, b) => isoToMs(a.t_wall) - isoToMs(b.t_wall));
  if (events.length === 0) return null;
  return { trace_id: id, events, skew_ms: r?.producers.includes('avatar') ? { 'agentd/1': 0, 'avatar/1': 12 } : { 'agentd/1': 0 } };
}

const OBS_APP: Readonly<Record<string, string>> = { a1a1a1a1a1a1: 'Terminal', a2a2a2a2a2a2: 'Xcode', a3a3a3a3a3a3: 'Safari', a4a4a4a4a4a4: '预览' };

/** `GET /diag/observations/<id>` for a recent request (capture.py `diagnostic_observation`); only an image that was seen carries a description. */
export function observationDetail(id: string): WireObservationDetail | null {
  const r = DIAG_STATE.observation.recent.find((x) => x.request_id === id);
  if (!r) return null;
  const seen = r.mode === 'image' && r.state === 'ready';
  return {
    request_id: id,
    mode: r.mode,
    status: r.state,
    reason: r.reason,
    app: OBS_APP[id] ?? null,
    requested_at: isoWithOffset(isoToMs(r.at) - 1800),
    observed_at: r.state === 'ready' ? r.at : null,
    current: seen,
    description: seen ? 'Xcode 前台，构建日志停在 HostLink.swift 第 214 行的错误：\n  Cannot find "reconnectDelay" in scope\n左侧导航选中 CompanionCore，右侧没有打开的检查器。' : null,
    description_truncated: false,
    content_available: seen,
    used_in_last_turn: seen,
  };
}

const sumRun = (id: string, at: string, outcome: string, ms: number, backend: string, span: [string, string] | null, episode: number | null, kind = 'memory_extract'): WireSummaryRun => ({
  run_id: id,
  kind,
  started_at: at,
  span_start: span?.[0] ?? null,
  span_end: span?.[1] ?? null,
  outcome,
  error: null,
  attempt: 1,
  duration_ms: ms,
  backend,
  model: backend === 'codex' ? 'gpt-5-mini' : 'claude-haiku-4-5',
  episode_id: episode,
  reasons: [],
});

/** `GET /summary/runs?date=2026-10-29`, newest first; other days have none. The last hour holds the flow chart's side lanes. */
export const SUMMARY_RUNS: WireSummaryRun[] = [
  ...[2, 6, 9, 13, 17, 21, 24, 28, 31].map((m, i) => sumRun(`oi-${i}`, isoAt(14, m, 5), i === 3 ? 'failed' : 'completed', 1100 + i * 40, 'claude_agent_sdk', null, null, 'observation_interpret')),
  sumRun('mr-4', isoAt(14, 26, 8), 'committed', 5400, 'claude_agent_sdk', [isoAt(13, 40), isoAt(14, 26)], null),
  sumRun('mr-3', isoAt(11, 47), 'failed', 2000, 'codex', null, null),
  sumRun('mr-2', isoAt(10, 42), 'no_new_knowledge', 3100, 'claude_agent_sdk', [isoAt(9, 55), isoAt(10, 40)], E2),
  sumRun('mr-1', isoAt(9, 50), 'committed', 6400, 'claude_agent_sdk', [isoAt(9, 2), isoAt(9, 48)], E1),
];

const ok = (body: unknown) => ({ status: 200, body });
/** `state=` of the page URL (`#/diag?state=…`); real agentd never sees it. */
const demoState = () => new URLSearchParams((globalThis.location?.hash ?? '').split('?')[1] ?? '').get('state');

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/diag/state',
    handler: () => (demoState() === 'error' ? { status: 0, body: null, error: { code: 'offline' } } : ok(demoParam() === 'sparse' ? SPARSE_STATE() : DIAG_STATE)),
  },
  { method: 'GET', path: '/capabilities', handler: () => ok(CAPABILITIES) },
  {
    method: 'GET',
    path: '/summary/runs',
    handler: ({ query }) => {
      const day = query.get('date') ?? '2026-10-29';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { status: 400, body: { error: 'invalid_date' } };
      const kinds = query.get('kinds')?.split(',');
      const all = demoParam() === 'sparse' ? SUMMARY_RUNS.filter((r) => r.run_id === 'mr-1') : SUMMARY_RUNS;
      return ok({ date: day, runs: day === '2026-10-29' && demoState() !== 'empty' ? all.filter((r) => !kinds || kinds.includes(r.kind)) : [] });
    },
  },
  {
    method: 'GET',
    path: '/diag/observations/:id',
    handler: ({ params }) => {
      const body = /^[0-9a-f]{12}$/.test(params.id ?? '') ? observationDetail(params.id ?? '') : null;
      return body ? ok(body) : { status: 404, body: { error: 'observation_not_found' } };
    },
  },
  {
    method: 'GET',
    path: '/trace/turns',
    handler: ({ query }) => {
      const since = query.get('since');
      const limit = Number(query.get('limit') ?? 50);
      const turnId = query.get('turn_id');
      const traceId = query.get('trace_id');
      if (since != null && !/[+-]\d{2}:\d{2}$|Z$/.test(since)) return { status: 400, body: { error: 'invalid_query' } };
      if (demoState() === 'empty') return ok({ turns: [] });
      const from = since != null ? isoToMs(since) : -Infinity;
      const rows = demoParam() === 'sparse' ? SPARSE_TRACE : TRACE_TURNS;
      return ok({ turns: rows.filter((r) => isoToMs(r.started_at) >= from && (turnId == null || r.turn_id === turnId) && (traceId == null || r.trace_id === traceId)).slice(0, limit) });
    },
  },
  {
    method: 'GET',
    path: '/trace/turns/:id',
    handler: ({ params, query }) => {
      const body = turnEvents(params.id ?? '', query.get('with_text') === '1');
      return body ? ok(body) : { status: 404, body: { error: 'unknown_trace' } };
    },
  },
  {
    method: 'GET',
    path: '/trace/decisions',
    handler: ({ query }) => {
      const since = query.get('since');
      const from = since != null ? isoToMs(since) : -Infinity;
      const trace = query.get('trace_id');
      const request = query.get('request_id');
      const events = (demoParam() === 'sparse' ? [] : DECISIONS).filter((e) => isoToMs(e.t_wall) >= from && (trace == null || e.trace_id === trace) && (request == null || e.attrs.request_id === request));
      return ok({ events: events.slice(0, Number(query.get('limit') ?? 100)) });
    },
  },
];
