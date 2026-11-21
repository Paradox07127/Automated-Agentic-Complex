// Overview reads in agentd's shapes. `?demo=…` and `?fail=1` pick a demo; the page sends them only to the fake bridge.
import { isoWithOffset } from '../domain/units';
import type { WireCommitment, WireDaySegments, WireDaySession, WireState } from '../pages/overview/wire';
import { atS, DAY, MINUTE, NOW, PRESENCE_ROLE, WIRE_APPROVALS, WIRE_DELIVERIES, WIRE_INTERACTIONS, WIRE_LEDGER, WIRE_OBSERVATION, WIRE_SESSIONS, WIRE_TASK_ROWS } from './fixtures';
import { C1, CHARACTER, S_3C77, S_41B0, S_5E10, S_9A41, S_C07A, S_D0C2, T2_LEDGER } from './fixtures/ids';
import type { MockResponse, MockRoute } from './types';

const NOW_S = NOW / 1000;
/** agentd's default `date` (server.py: today); the fixtures' day. */
const TODAY = '2026-10-29';
const ok = (body: unknown): MockResponse => ({ status: 200, body });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});

/** `commitments` rows (commitments.py COLUMNS): two went off this morning (the first one's card was shown), two armed this afternoon, one tomorrow morning. */
const WIRE_COMMITMENTS: Array<WireCommitment & { revision: number }> = [
  { id: 'c2b3c4d5e6f7', text: '站会', due_at: atS(10, 30), state: 'fulfilled', created_at: atS(9, 5), created_line: null, delivered_line: '站会时间到了。', updated_at: atS(10, 31), revision: 1, repeat: null, trigger: null, seen_at: atS(10, 30, 5) },
  { id: 'c3c4d5e6f7a8', text: '午餐', due_at: atS(12, 0), state: 'triggered', created_at: atS(9, 6), created_line: null, delivered_line: '该吃午饭了。', updated_at: atS(12, 0), revision: 1, repeat: null, trigger: null, seen_at: null },
  { id: 'c0a1b2c3d4e5', text: '交报销单', due_at: atS(15, 0), state: 'armed', created_at: atS(9, 12), created_line: null, delivered_line: null, updated_at: atS(9, 12), revision: 1, repeat: null, trigger: null, seen_at: null },
  { id: 'c0f6a7b8c9d0', text: '周会', due_at: atS(16, 30), state: 'armed', created_at: atS(10, 3), created_line: null, delivered_line: null, updated_at: atS(10, 3), revision: 1, repeat: null, trigger: null, seen_at: null },
  { id: 'c1a2b3c4d5e6', text: '给房东打电话', due_at: atS(9, 0) + DAY / 1000, state: 'armed', created_at: atS(11, 30), created_line: null, delivered_line: null, updated_at: atS(11, 30), revision: 1, repeat: null, trigger: null, seen_at: null },
];

/** The ledger keeps an agent's bare session id; the registry names the same session `<source>:<id>`. */
const bare = (display: string) => display.slice(display.indexOf(':') + 1);

const ledgerSession = (display: string, start: number, end: number, gate: WireDaySession['last_gate'] = null, failed = 0): WireDaySession => ({
  session_id: bare(display),
  started_at: start,
  ended_at: end,
  agents_done: 2,
  agents_failed: failed,
  last_gate: gate,
  guard_blocks: 0,
});

/** `GET /day/segments` (day_summary.segments): ledger sessions per project plus own sessions started today. */
function daySegments(date: string): WireDaySegments {
  return {
    date,
    projects: [
      {
        project: 'Users-me-Endfield',
        name: 'Endfield',
        sessions: [
          ledgerSession(S_41B0, atS(10, 5), atS(11, 40), { at: atS(11, 40), passed: false }, 1),
          ledgerSession(S_3C77, atS(12, 10), atS(12, 55), { at: atS(12, 54), passed: true }),
          ledgerSession(S_5E10, atS(13, 51), atS(14, 32, 6)),
          ledgerSession(S_D0C2, atS(14, 23), atS(14, 25)),
        ],
        own: [
          {
            session_id: S_C07A,
            title: '修 HostLink 断线重连',
            state: 'awaiting_approval',
            last_line: '待批准：Edit Sources/CompanionCore/HostLink.swift',
            started_at: atS(14, 20),
            updated_at: atS(14, 31, 38),
            task_id: T2_LEDGER,
          },
        ],
      },
      { project: 'Users-me-Endfield-pipeline', name: 'pipeline', sessions: [ledgerSession(S_9A41, atS(13, 32), atS(14, 32))], own: [] },
    ],
  };
}

/** `GET /agent/snapshot`: every part is that route's body; conversations, jobs and task_understanding answer 503 here. */
function snapshot(demo: string | null) {
  const nowait = demo === 'nowait';
  return {
    stream_epoch: '7c1e0a42',
    seq: 18422,
    conversations: null,
    interactions: { requests: nowait ? [] : WIRE_INTERACTIONS },
    jobs: null,
    tasks: { tasks: WIRE_LEDGER },
    personal_tasks: { tasks: WIRE_TASK_ROWS, next_cursor: null },
    deliveries: { deliveries: nowait ? WIRE_DELIVERIES.filter((d) => d.decided_at != null) : WIRE_DELIVERIES, next_cursor: null },
    task_understanding: null,
    commitments: { commitments: WIRE_COMMITMENTS },
    approvals: { approvals: nowait ? [] : WIRE_APPROVALS },
  };
}

/** registry.py Session.to_dict() of the external `/sessions` rows; priority is the state's index in registry.py STATES. */
const STATES = ['awaiting_approval', 'awaiting_input', 'error', 'running_tool', 'thinking', 'compacting', 'subagent', 'done', 'background', 'stale', 'idle'];
const REGISTRY_SESSIONS = WIRE_SESSIONS.filter((s) => !s.own).map((s) => {
  const state = s.state === 'running' ? 'running_tool' : s.state;
  return {
    display_session: `${s.target}:${s.session_id}`, source: s.target, session_id: s.session_id, cwd: s.cwd, state,
    effective_state: state, priority: STATES.indexOf(state), since: s.updated_at, started_at: null, completed_at: state === 'done' ? s.updated_at : null,
    failed_at: state === 'error' ? s.updated_at : null, expires_at: null, tool_name: null,
    tool_category: null, tool_target: null, last_tool_name: null, last_tool_target: null, subagents: [], pending_approvals: [], coalesced: 0, outcomes: [], origin: null,
    observed_at: s.observed_at ?? s.updated_at, capabilities: s.capabilities ?? ['observe'],
  };
});

/** registry.py role focus of the foreground run (embodiment.py `_focus`), the same run presence shows. */
const ROLE_FOCUS = {
  display_session: `role:${PRESENCE_ROLE.run_id}`, state: PRESENCE_ROLE.state, priority: STATES.indexOf(PRESENCE_ROLE.state),
  tool_name: null, tool_category: null, expires_at: null, run_id: PRESENCE_ROLE.run_id, conversation_id: C1, run_generation: 1,
  phase: PRESENCE_ROLE.phase, outcome: null, intent_override: null, backend: 'codex', since: PRESENCE_ROLE.since / 1000,
  additional_runs: 0,
  background_runs: 0,
  background: [],
};

/** `GET /state`; `demo=pause|quiet` sets a window in force. */
function state(demo: string | null): WireState & Record<string, unknown> {
  return {
    epoch: Math.floor(atS(8, 0)),
    focus: demo === 'empty'
      ? { display_session: null, state: 'idle', priority: 10, tool_name: null, tool_category: null, expires_at: null }
      : ROLE_FOCUS,
    sessions: REGISTRY_SESSIONS,
    outcomes: [],
    character: CHARACTER,
    character_generation: 1,
    switching: null,
    turn_generation: 42,
    observation: {
      ...WIRE_OBSERVATION,
      paused_until: demo === 'pause' ? isoWithOffset(NOW + 18 * MINUTE) : null,
      quiet_until: demo === 'quiet' ? isoWithOffset(NOW + 58 * MINUTE) : null,
    },
    avatar: { visible: true, reason: null, since: isoWithOffset(NOW - 90 * MINUTE) },
  };
}

/** server.py `_commitment_action`: snooze takes exactly {minutes: 5 | 10 | 15 | 60}; replies {commitment}. */
function settle(id: string | undefined, action: 'snooze' | 'complete' | 'cancel', body: unknown): MockResponse {
  const row = WIRE_COMMITMENTS.find((c) => c.id === id);
  if (action === 'snooze') {
    const b = obj(body);
    if (Object.keys(b).join() !== 'minutes' || ![5, 10, 15, 60].includes(b.minutes as number)) return { status: 400, body: { error: 'invalid_payload', field: 'minutes' } };
  }
  if (!row) return { status: 404, body: { error: 'unknown_commitment' } };
  const minutes = obj(body).minutes as number;
  const next = action === 'snooze' ? { state: 'armed', due_at: NOW_S + minutes * 60 } : { state: action === 'complete' ? 'fulfilled' : 'cancelled' };
  return ok({ commitment: { ...row, ...next, updated_at: NOW_S } });
}

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/agent/snapshot',
    handler: ({ query }) => (query.get('fail') ? { status: 500, body: { error: 'internal_error' } } : ok(snapshot(query.get('demo')))),
  },
  { method: 'GET', path: '/state', handler: ({ query }) => ok(state(query.get('demo'))) },
  {
    method: 'GET',
    path: '/day/segments',
    handler: ({ query }) => {
      const date = query.get('date') ?? TODAY;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, body: { error: 'invalid_date' } };
      if (query.get('demo') === 'ov2-lane-error') return { status: 500, body: { error: 'internal_error' } };
      return ok(daySegments(date));
    },
  },
  { method: 'GET', path: '/commitments', handler: () => ok({ commitments: WIRE_COMMITMENTS }) },
  { method: 'POST', path: '/commitments/:id/snooze', handler: ({ params, body }) => settle(params.id, 'snooze', body) },
  { method: 'POST', path: '/commitments/:id/complete', handler: ({ params, body }) => settle(params.id, 'complete', body) },
  { method: 'POST', path: '/commitments/:id/cancel', handler: ({ params, body }) => settle(params.id, 'cancel', body) },
];
