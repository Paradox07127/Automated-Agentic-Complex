// What the 状态签 and 任务轨 read from agentd's `/desktop/presence` (desktop_presence.py `snapshot`): epoch seconds, ≤3 rows per list.
import { sessionName } from '../../../domain';
import { stackQuery } from '../../stack/demos';
import { presenceSessions } from '../../stack/sessions';
import type { Bar } from '../comm/commReducer';
import type { Ritual } from './useRitual';

/** Session and run states that count as in progress (desktop_presence.py `ACTIVE`). */
export const ACTIVE: ReadonlySet<string> = new Set(['thinking', 'running_tool', 'awaiting_approval', 'awaiting_input', 'compacting', 'subagent']);

/** Short state words; agentd's own labels address the user. */
const STATE_LABEL: Readonly<Record<string, string>> = {
  thinking: '思考中',
  running_tool: '工具执行中',
  awaiting_approval: '待批准',
  awaiting_input: '待回答',
  compacting: '整理上下文中',
  subagent: '派发子任务中',
  done: '已完成',
  background: '后台执行中',
  error: '出错',
  stale: '无更新',
  idle: '空闲',
};

export const stateLabel = (state: string): string => STATE_LABEL[state] ?? '状态未知';

export interface PresenceRole {
  state: string;
  intention: string | null;
  backend: string | null;
  runId: string | null;
  outcome: string | null;
  additionalRuns: number;
  backgroundRuns: number;
  /** Her active background runs, each cancellable by run id and generation. */
  background: { runId: string; generation: number; title: string }[];
  /** Epoch seconds the run started. */
  since: number | null;
}

export interface PresenceSession {
  id: string;
  title: string;
  state: string;
  /** desktop_presence.py `_status`: needs_you, error, done or running. */
  status: string;
  /** Waits for a permission answer in its own app, which Agentic Complex cannot give. */
  ownApp: boolean;
}

/** Her latest thought (thoughts.py `latest`); `offer` is her question, `reply` the user's acceptance. */
export interface PresenceThought {
  id: string;
  text: string;
  offer: string | null;
  reply: string | null;
}

/** Her one state for the status tag (agent_state.py `agent_state`); `since` in epoch seconds. */
export interface PresenceAgent {
  state: 'working' | 'waiting_you' | 'done' | 'failed' | 'idle';
  since: number | null;
  count: number;
}

const AGENT_STATES: ReadonlySet<string> = new Set(['working', 'waiting_you', 'done', 'failed']);

export interface PresenceView {
  /** Epoch seconds agentd took the snapshot. */
  sampledAt: number | null;
  role: PresenceRole | null;
  /** Rows plus `_more` per kind. */
  pending: { approvals: number; questions: number; reviews: number };
  /** Observed sessions waiting for a permission answer in their own app; Agentic Complex cannot answer them. */
  observedWaiting: number;
  sessions: PresenceSession[];
  moreSessions: number;
  /** The ritual a tap would say now; `since` in epoch ms. */
  ritual: Ritual | null;
  agent: PresenceAgent;
  /** The running focus session (focus.py `presence`): `until` in epoch seconds. */
  focus: { until: number; minutes: number } | null;
  thought: PresenceThought | null;
  /** Due reminders, rows plus `_more`. */
  reminders: number;
  /** Native could not reach agentd for a while; the rest is the last presence it had. */
  offline: boolean;
  /** The voice service; null from an agentd that does not send it. */
  voice: { state: string; muted: boolean } | null;
  observation: { paused: boolean };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function count(pending: Obj | null, key: string): number {
  const rows = pending?.[key];
  return (Array.isArray(rows) ? rows.length : 0) + Math.max(0, num(pending?.[`${key}_more`]) ?? 0);
}

export function readPresence(raw: unknown): PresenceView {
  const p = obj(raw);
  const r = obj(p?.role);
  const pending = obj(p?.pending);
  const sessions = Array.isArray(p?.sessions) ? p.sessions : [];
  const rit = obj(p?.ritual);
  const ritualKind = str(rit?.kind);
  const ritualSince = num(rit?.since);
  const agent = obj(p?.agent);
  const agentState = str(agent?.state);
  const focus = obj(p?.focus);
  const focusUntil = num(focus?.until);
  const thought = obj(p?.thought);
  const thoughtId = str(thought?.id);
  const thoughtText = str(thought?.text);
  const voice = obj(p?.voice);
  const voiceState = str(voice?.state);
  return {
    sampledAt: num(p?.sampled_at),
    role: r && {
      state: str(r.state) ?? 'idle',
      intention: str(r.intention),
      backend: str(r.backend),
      runId: str(r.run_id),
      outcome: str(r.outcome),
      additionalRuns: Math.max(0, num(r.additional_runs) ?? 0),
      backgroundRuns: Math.max(0, num(r.background_runs) ?? 0),
      background: (Array.isArray(r.background) ? r.background : []).flatMap((b) => {
        const row = obj(b);
        const runId = str(row?.run_id);
        const generation = num(row?.generation);
        return runId && generation != null ? [{ runId, generation, title: str(row?.title) ?? '后台任务' }] : [];
      }),
      since: num(r.since),
    },
    pending: { approvals: count(pending, 'approvals'), questions: count(pending, 'questions'), reviews: count(pending, 'results') },
    observedWaiting: Math.max(0, num(pending?.observed_waiting) ?? 0),
    sessions: sessions.flatMap((s) => {
      const row = obj(s);
      const id = str(row?.id);
      return id ? [{ id, title: str(row?.title) ?? sessionName(), state: str(row?.state) ?? 'idle', status: str(row?.status) ?? 'running', ownApp: row?.own_app === true }] : [];
    }),
    moreSessions: Math.max(0, num(p?.additional_sessions) ?? 0),
    ritual: ritualKind ? { kind: ritualKind, since: ritualSince != null ? ritualSince * 1000 : Date.now() } : null,
    agent:
      agentState && AGENT_STATES.has(agentState)
        ? { state: agentState as PresenceAgent['state'], since: num(agent?.since), count: Math.max(0, num(agent?.count) ?? 0) }
        : { state: 'idle', since: null, count: 0 },
    focus: focusUntil != null ? { until: focusUntil, minutes: num(focus?.minutes) ?? 0 } : null,
    thought: p?.proactive_speech !== false && thoughtId && thoughtText ? { id: thoughtId, text: thoughtText, offer: str(thought?.offer), reply: str(thought?.reply) } : null,
    reminders: count(pending, 'reminders'),
    offline: p?.offline === true,
    voice: voiceState ? { state: voiceState, muted: voice?.muted === true } : null,
    observation: { paused: obj(p?.observation)?.paused === true },
  };
}

/** The presence after native's push `raw`: its `{offline: true}` keeps the last presence, marked offline. */
export function nextPresence(last: unknown, raw: unknown): unknown {
  return obj(raw)?.offline === true ? { ...obj(last), offline: true } : raw;
}

/** The status mark's states, highest first: amber diamond, red cross, blue spinner (her run, or a line on its way), tick, unplugged. */
export type ChipKind = 'running' | 'offline' | 'waiting' | 'done' | 'error';

export interface StatusChip {
  kind: ChipKind;
  /** waiting: the approvals, questions and own-app waits; else 0. */
  count: number;
  /** error: the errors it stands for, which stay until seen. */
  errors: string[];
  /** Epoch ms it goes by itself (done); null otherwise. */
  until: number | null;
}

/** Role states the chip shows as the cyan spinner. */
const RUNNING: ReadonlySet<string> = new Set(['thinking', 'running_tool', 'subagent', 'compacting', 'background']);
/** A done session or run shows its tick this long. */
export const CHIP_DONE_MS = 8000;

/**
 * The status chip beside her for the states that carry no message of their own: null for idle, activity and
 * stale. `bar` is her main line, `now` agentd's clock in epoch ms, `seen` the errors the user has opened.
 */
export function chipOf(raw: unknown, bar: Bar | null, now: number, seen: ReadonlySet<string> = new Set()): StatusChip | null {
  const p = readPresence(raw);
  const chip = (kind: ChipKind, rest: Partial<StatusChip> = {}): StatusChip => ({ kind, count: 0, errors: [], until: null, ...rest });
  if (p.offline) return chip('offline');
  const role = p.role?.state ?? 'idle';
  const own = Math.max(p.observedWaiting, p.sessions.filter((s) => s.ownApp).length);
  const asks = Math.max(p.pending.approvals + p.pending.questions, p.sessions.filter((s) => s.status === 'needs_you' && !s.ownApp).length);
  if (asks + own > 0 || role === 'awaiting_approval' || role === 'awaiting_input') return chip('waiting', { count: Math.max(1, asks + own) });
  const errors = [
    bar?.phase === 'error' ? `line:${bar.id}` : null,
    ...p.sessions.filter((s) => s.status === 'error').map((s) => `session:${s.id}`),
    p.agent.state === 'failed' ? `agent:${p.agent.since ?? ''}` : null,
    role === 'error' ? `role:${p.role?.runId ?? p.role?.since ?? ''}` : null,
  ].filter((k): k is string => k != null && !seen.has(k));
  if (errors.length > 0) return chip('error', { errors });
  if (bar?.phase === 'thinking' || RUNNING.has(role)) return chip('running');
  const finished = [
    ...presenceSessions(raw).rows.filter((r) => r.status === 'done').map((r) => r.updatedAt),
    p.agent.state === 'done' && p.agent.since != null ? p.agent.since * 1000 : 0,
  ];
  const until = Math.max(0, ...finished) + CHIP_DONE_MS;
  return now < until ? chip('done', { until }) : null;
}

/** `demo=` of a desktop page on the fake bridge; null under the shell. */
export function fakeDemo(): string | null {
  return window.agenticComplex ? null : stackQuery().get('demo');
}
