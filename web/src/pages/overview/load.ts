import { getBridge, type AgentdConnection } from '../../bridge';
import { get } from '../../bridge/agentd';
import { appNow } from '../../bridge/clock';
import {
  activityLabel,
  composeHealth,
  fromApproval,
  fromCodingReview,
  fromDelivery,
  fromDiagBudget,
  fromInteraction,
  fromLedgerTask,
  fromRun,
  fromSession,
  fromTaskRow,
  indexActiveRuns,
  isoToMs,
  isoToMsOrNull,
  isCodingReview,
  isReviewableDelivery,
  isoWithOffset,
  mergeTasks,
  runFailure,
  secToMs,
  secToMsOrNull,
  type ActiveRun,
  type Budget,
  type CharacterState,
  type Delivery,
  type ErrorEntry,
  type Health,
  type PendingItem,
  type Review,
  type Run,
  type RunState,
  type RuntimeInfo,
  type Session,
  type Task,
  type WireCharacterState,
  type WireDiagState,
  type WireRun,
  type WireSession,
  type WireTraceTurn,
} from '../../domain';
import { verifyText } from '../../domain/errorText';
import { errText } from './errors';
import { roleOf, type RoleNow } from './role';
import type { WireAgentSnapshot, WireCommitment, WireDaySegments, WireState } from './wire';

/** The /diag/state blocks the overview reads. */
type OverviewDiag = Pick<WireDiagState, 'budget' | 'gate' | 'connections' | 'context' | 'behavior' | 'observation' | 'body'>;

export interface Reminder {
  id: string;
  title: string;
  due_at: number;
  /** Already announced: triggered, fulfilled or missed. */
  triggered: boolean;
  /** When its card was first on screen since it last came due. */
  seen_at: number | null;
}

export interface DaySession {
  id: string;
  started_at: number;
  ended_at: number | null;
  agents_failed: number;
  last_gate: 'pass' | 'fail' | null;
}

export type CharacterMood = Pick<CharacterState, 'energy' | 'valence' | 'engagement' | 'labels'>;

export interface Pause {
  paused_until: number | null;
  quiet_until: number | null;
  meeting: boolean;
  /** Observation switched off by a launch flag. */
  off: boolean;
}

/** What the overview shows, put together from agentd's reads and the bridge. A null region could not be read. */
export interface OverviewSnapshot {
  /** Clock when `/agent/snapshot` was read; approval countdowns count from it. */
  now: number;
  connection: AgentdConnection;
  /** `/agent/snapshot` seq: the feed is read after it. */
  seq: string;
  pending: PendingItem[];
  tasks: Task[];
  active_runs: Record<string, ActiveRun>;
  sessions: Session[];
  deliveries: Delivery[];
  reminders: Reminder[];
  /** Today's failed tasks. */
  errors: ErrorEntry[];
  character: { id?: string | null; name: string | null; en?: string | null; head?: string | null; mood: CharacterMood | null };
  /** What she thinks you are doing now (/diag/state context.activity), in Chinese; null when unknown. */
  activity: string | null;
  /** The role band's live line (/diag/state). */
  role: RoleNow | null;
  /** Its runtime half and `kernel` come from the separate kernel read (`withRuntime`). */
  health: Health | null;
  kernel: { runtime: RuntimeInfo; alternative: RuntimeInfo | null } | null;
  quota: Pick<Budget, 'screenshots' | 'gate'> | null;
  /** Why `/diag/state` (role line, health, quota) could not be read; null when it was. */
  diag_error: string | null;
  day: {
    /** Today's runs; `task_id` is the canonical id of the task row the run belongs to, so a bar opens that task. */
    runs: Run[];
    segments: Array<{ project: string; agent: string; sessions: DaySession[] }>;
    /** Lane id → why that lane could not be read; the other lanes still draw. */
    lane_errors: Record<string, string>;
  };
  pause: Pause | null;
}

export const clock = appNow;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day as `/day/segments?date=` takes it. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One side read on its own: a failed read, or a reply its adapter cannot read, blanks only its region. */
function part<W, D>(r: PromiseSettledResult<W>, adapt: (w: W) => D): D | null {
  if (r.status === 'rejected') return null;
  try {
    return adapt(r.value);
  } catch {
    return null;
  }
}

function reviewOf(d: Delivery, task: Task | undefined): Review {
  const title = task?.title || d.title;
  return {
    id: `r-${d.id}`,
    kind: 'review',
    task_id: d.task_id,
    delivery_id: d.id,
    title: `${title} v${d.version}`,
    source: `角色任务 │ ${title}`,
    since: d.presented_at ?? d.produced_at,
    revision: d.revision,
    generation: d.generation,
    verification_source: d.verification_source,
  };
}

/** The version the task row names, else the newest listed one of its task. */
function isCurrent(d: Delivery, all: readonly Delivery[], tasks: readonly Task[]): boolean {
  const named = tasks.find((t) => t.id === d.task_id)?.delivery;
  return named ? named.id === d.id : !all.some((x) => x.task_id === d.task_id && x.version > d.version);
}

/** Session states with work in progress, as the run state their row shows. */
const LIVE_SESSION: Readonly<Record<string, RunState>> = {
  running: 'running',
  accepted: 'running',
  thinking: 'thinking',
  running_tool: 'running_tool',
  awaiting_approval: 'awaiting_approval',
  awaiting_input: 'awaiting_input',
  error: 'error',
};

/** Own coding sessions have no `/agent/runs` row; their task's live line comes from `/sessions`. */
function sessionRuns(sessions: readonly Session[], tasks: readonly Task[]): Record<string, ActiveRun> {
  const out: Record<string, ActiveRun> = {};
  for (const s of sessions) {
    const state = s.own ? LIVE_SESSION[s.state] : undefined;
    const t = state ? tasks.find((x) => x.id === s.task_id && x.ended_at == null) : undefined;
    if (!state || !t) continue;
    out[t.id] = { run_id: s.id, task_id: t.task_id, generation: 0, conversation_id: null, state, phase: null, started_at: t.started_at ?? t.created_at, since: s.since, plan: null };
  }
  return out;
}

/** Ledger rows carry the agent's bare session id; the registry names it `<source>:<id>`. A session still live there has not ended. */
function daySegments(w: WireDaySegments, sessions: readonly Session[]): OverviewSnapshot['day']['segments'] {
  const ledgerRow = (s: WireDaySegments['projects'][number]['sessions'][number]): DaySession[] => {
    if (s.started_at == null) return [];
    const live = sessions.find((x) => !x.own && x.id.endsWith(`:${s.session_id}`));
    return [
      {
        id: live?.id ?? s.session_id,
        started_at: secToMs(s.started_at),
        ended_at: live && live.state !== 'idle' ? null : secToMsOrNull(s.ended_at),
        agents_failed: s.agents_failed,
        last_gate: s.last_gate ? (s.last_gate.passed ? 'pass' : 'fail') : null,
      },
    ];
  };
  return w.projects.map((p) => ({
    project: p.project,
    agent: p.name,
    sessions: [
      ...p.sessions.flatMap(ledgerRow),
      ...p.own.map((o): DaySession => ({ id: o.session_id, started_at: secToMs(o.started_at), ended_at: LIVE_SESSION[o.state] ? null : secToMs(o.updated_at), agents_failed: 0, last_gate: null })),
    ],
  }));
}

type TimedCommitment = WireCommitment & { due_at: number };

const reminderOf = (c: TimedCommitment): Reminder => ({
  id: c.id,
  title: c.text,
  due_at: secToMs(c.due_at),
  triggered: c.state !== 'armed',
  seen_at: c.seen_at === null ? null : secToMs(c.seen_at),
});

/** Armed timed reminders, and today's that already went off (drawn greyed on the brief's ruler); one waiting for a trigger has no time to draw. */
const shownReminder = (c: WireCommitment, now: number): c is TimedCommitment =>
  c.due_at !== null && (c.state === 'armed' || (c.state !== 'cancelled' && dayOf(secToMs(c.due_at)) === dayOf(now)));

/** `/agent/snapshot` with the clock and connection it was read at. */
export interface SnapshotRead {
  now: number;
  connection: AgentdConnection;
  wire: WireAgentSnapshot;
}

/** 待处理 reads `/agent/snapshot` alone, so approvals never wait for the other reads. `demo` and `fail` only reach the mock. */
export async function readSnapshot(demo: string | null, fail: boolean): Promise<SnapshotRead> {
  const connection = await getBridge().agentd.connection();
  const now = clock();
  const fake = !window.agenticComplex;
  const wire = await get<WireAgentSnapshot>(`/agent/snapshot${fake ? `?demo=${demo ?? ''}${fail ? '&fail=1' : ''}` : ''}`);
  return { now, connection, wire };
}

export interface RunningRead {
  sessions: Session[];
  runs: WireRun[];
}

/** 进行中: `/sessions` and `/agent/runs`. */
export async function readRunning(): Promise<RunningRead> {
  const [s, r] = await Promise.all([get<{ sessions: WireSession[] }>('/sessions'), get<{ runs: WireRun[] }>('/agent/runs')]);
  return { sessions: s.sessions.map(fromSession), runs: r.runs };
}

/** Today's failed turns, counted under 出错. */
export async function readFailedTurns(now: number): Promise<ErrorEntry[]> {
  const since = isoWithOffset(new Date(now).setHours(0, 0, 0, 0));
  const r = await get<{ turns: WireTraceTurn[] }>(`/trace/turns?since=${encodeURIComponent(since)}&result=failed&limit=50`);
  // The mock ignores `result`; agentd filters by it.
  return r.turns.filter((x) => x.result === 'failed').map(turnError);
}

/** The role band's reads; each blanks only its own part. */
export type RoleRead = Pick<OverviewSnapshot, 'character' | 'activity' | 'role' | 'health' | 'quota' | 'pause' | 'diag_error'> & { connection: AgentdConnection };

/** `/state`, `/character/state`, `/diag/state` and the bridge's character list and supervisor. */
export async function readRole(demo: string | null): Promise<RoleRead> {
  const bridge = getBridge();
  const fake = !window.agenticComplex;
  const [connection, [state, character, diag, profiles, supervisor]] = await Promise.all([
    bridge.agentd.connection(),
    Promise.allSettled([
      get<WireState>(`/state${fake && demo ? `?demo=${demo}` : ''}`),
      get<WireCharacterState>('/character/state'),
      get<OverviewDiag>('/diag/state'),
      bridge.character.list(),
      bridge.supervisor.state(),
    ]),
  ]);
  const sup = supervisor.status === 'fulfilled' ? supervisor.value : null;
  // The diag read's health has no runtime half; withRuntime fills it.
  const diagView = part(diag, (d) => ({ health: composeHealth(connection, null, sup, d), quota: fromDiagBudget(d.budget, d.gate) }));
  return {
    connection,
    character: {
      name: part(profiles, (list) => list.find((c) => c.active)?.name ?? null),
      ...part(profiles, (list) => ({ id: list.find((c) => c.active)?.id ?? null, en: list.find((c) => c.active)?.en ?? null, head: list.find((c) => c.active)?.head ?? null })),
      mood: part(character, (c) => ({ energy: c.energy, valence: c.valence, engagement: c.engagement, labels: c.labels ?? { energy: '', mood: '', engagement: '' } })),
    },
    activity: part(diag, (d) => (d.context?.activity ? activityLabel(d.context.activity.activity) : null)),
    role: part(diag, roleOf),
    health: diagView?.health ?? null,
    quota: diagView ? { screenshots: diagView.quota.screenshots, gate: diagView.quota.gate } : null,
    diag_error: diag.status === 'rejected' ? errText(diag.reason) : diagView ? null : '回复无法读取',
    pause: part(state, (st) => ({
      paused_until: isoToMsOrNull(st.observation.paused_until),
      quiet_until: isoToMsOrNull(st.observation.quiet_until),
      meeting: st.observation.meeting,
      off: st.observation.off,
    })),
  };
}

/** Today's coding sessions per project, for 进行中 start times and the brief. */
export function readDay(demo: string | null, now: number): Promise<WireDaySegments> {
  const fake = !window.agenticComplex;
  return get<WireDaySegments>(`/day/segments?date=${dayOf(now)}${fake && demo ? `&demo=${demo}` : ''}`);
}

/** Why a failed task failed: a coding task's verify result (a failed one without a verify command was sent back), else its run's failure. */
function failReason(t: Task, runs: readonly WireRun[]): string {
  if (t.verify?.reason === 'no_verify_cmd') return '已退回';
  if (t.verify) return verifyText(t.verify);
  return runFailure(runs.find((r) => r.run_id === t.run_id))?.reason ?? '运行失败';
}

/** A failed turn of today; the fix opens it in the timeline. */
const turnError = (r: WireTraceTurn): ErrorEntry => ({ id: r.trace_id, kind: 'turn', at: isoToMs(r.started_at), title: r.head || '一轮对话', reason: '这一轮没有完成', fix: '看时间线' });

/** The section reads that have answered so far; a missing one leaves its part empty. */
export interface OverviewParts {
  snapshot?: SnapshotRead | undefined;
  running?: RunningRead | undefined;
  /** Why `/sessions` or `/agent/runs` could not be read. */
  runningError?: string | undefined;
  turns?: ErrorEntry[] | undefined;
  role?: RoleRead | undefined;
  day?: WireDaySegments | undefined;
  dayError?: string | undefined;
}

const NO_ROLE: RoleRead = { connection: 'connected', character: { name: null, mood: null }, activity: null, role: null, health: null, quota: null, pause: null, diag_error: null };

/** The page's view of the section reads; each section shows only once its own read has answered. */
export function overviewOf(p: OverviewParts): OverviewSnapshot {
  const now = p.snapshot?.now ?? clock();
  const s = p.snapshot?.wire;
  const wireRuns = p.running?.runs ?? [];
  const sessions = p.running?.sessions ?? [];
  const ledger = s?.tasks?.tasks ?? [];
  const rows = s?.personal_tasks?.tasks ?? [];
  const tasks = mergeTasks(
    rows.map((r) => fromTaskRow(r, ledger.find((l) => l.task_id === r.task_id), wireRuns.find((x) => x.run_id === r.run_id))),
    ledger.map(fromLedgerTask),
    sessions,
  );
  const deliveries = (s?.deliveries?.deliveries ?? []).map(fromDelivery);
  const pending: PendingItem[] = [
    ...(s?.interactions?.requests ?? []).map((q) => fromInteraction(q, now)),
    ...(s?.approvals?.approvals ?? []).map((a) => fromApproval(a, now)),
    ...deliveries.filter((d) => isReviewableDelivery(d, tasks.find((t) => t.id === d.task_id)) && isCurrent(d, deliveries, tasks)).map((d) => reviewOf(d, tasks.find((t) => t.id === d.task_id))),
    ...tasks.filter(isCodingReview).map(fromCodingReview),
  ];
  const { connection: roleConnection, ...role } = p.role ?? NO_ROLE;
  const connection = p.snapshot?.connection ?? roleConnection;

  const laneErrors: Record<string, string> = {};
  if (p.runningError) laneErrors.runs = `读取运行记录失败：${p.runningError}`;
  const segments = p.day ? part({ status: 'fulfilled', value: p.day }, (d) => daySegments(d, sessions)) : null;
  if (p.day && !segments) laneErrors.code = '读取编码记录失败：回复无法读取';
  else if (p.dayError) laneErrors.code = `读取编码记录失败：${p.dayError}`;

  return {
    now,
    connection,
    seq: s ? String(s.seq) : '',
    pending,
    tasks,
    active_runs: { ...indexActiveRuns(wireRuns, tasks), ...sessionRuns(sessions, tasks) },
    sessions,
    deliveries,
    reminders: (s?.commitments?.commitments ?? []).filter((c) => shownReminder(c, now)).map(reminderOf),
    errors: [
      ...tasks
        .filter((t) => t.status === 'failed' && t.ended_at != null && dayOf(t.ended_at) === dayOf(now))
        .map((t): ErrorEntry => ({ id: t.id, kind: 'task', at: t.ended_at ?? now, title: t.title, reason: failReason(t, wireRuns), fix: '查看任务' })),
      ...(p.turns ?? []),
    ].sort((a, b) => b.at - a.at),
    ...role,
    health: role.health && { ...role.health, agentd: { ...role.health.agentd, up: connection === 'connected' } },
    kernel: null,
    day: {
      runs: wireRuns
        .map(fromRun)
        .filter((r) => r.ended_at == null || dayOf(r.started_at) === dayOf(now))
        .map((r) => ({ ...r, task_id: r.task_id && (tasks.find((t) => t.run_id === r.run_id)?.id ?? null) })),
      segments: segments ?? [],
      lane_errors: laneErrors,
    },
  };
}

/** `state=empty`: the same role band with no work anywhere. */
export function emptyWork(s: OverviewSnapshot): OverviewSnapshot {
  return { ...s, pending: [], tasks: [], active_runs: {}, sessions: [], deliveries: [], reminders: [], errors: [], day: { runs: [], segments: [], lane_errors: {} } };
}

/** `demo=sparse` on the fake bridge: a quiet day, nothing waiting or running, one reminder ahead. */
export function sparseWork(s: OverviewSnapshot): OverviewSnapshot {
  const next = s.reminders.filter((r) => !r.triggered && r.due_at > s.now).sort((a, b) => a.due_at - b.due_at).slice(0, 1);
  return { ...emptyWork(s), reminders: next };
}
