import { useQuery } from '@tanstack/react-query';
import { getBridge, type AgentdConnection, type BridgeError } from '../bridge';
import { request } from '../bridge/agentd';
import { appNow } from '../bridge/clock';
import {
  fromApproval,
  fromDelivery,
  fromGoal,
  fromInteraction,
  fromLedgerTask,
  fromSession,
  fromTaskRow,
  indexActiveRuns,
  mergeTasks,
  type ActiveRun,
  type Approval,
  type Delivery,
  type Goal,
  type Question,
  type Session,
  type Task,
  type WireApproval,
  type WireDelivery,
  type WireGoal,
  type WireInteraction,
  type WireLedgerTask,
  type WireRun,
  type WireSession,
  type WireTaskRow,
} from '../domain';
import { failureText } from '../domain/errorText';

/** Everything the task page lists, as domain objects. `roleMissing` = `/agent/tasks` answered 404. */
export interface TasksBase {
  tasks: Task[];
  /** Every version of every task; only a row's current one (`task.delivery`) can be reviewed. */
  deliveries: Delivery[];
  sessions: Session[];
  approvals: Approval[];
  questions: Question[];
  goals: Goal[];
  activeRuns: Record<string, ActiveRun>;
  roleMissing: boolean;
  /** agentd reported offline although the bridge still served this data, so it is the last data read. */
  offline?: boolean;
}

export interface Got<T> {
  status: number;
  body: T | null;
  error?: BridgeError;
}

export type LoadFail = 'not_found' | 'disconnected' | 'other';

/** Why a read failed: code `offline` or an offline agentd = disconnected; 404 = endpoint missing; else other (bridge refusals included). */
export function classify(res: { status: number; error?: BridgeError }, conn: AgentdConnection): LoadFail | null {
  if (res.status === 200) return null;
  if (conn === 'offline' || res.error?.code === 'offline') return 'disconnected';
  return res.status === 404 ? 'not_found' : 'other';
}

export class TasksLoadError extends Error {
  readonly kind: LoadFail;
  /** The raw code when the message is a generic sentence; the page keeps it in a tooltip. */
  readonly code: string | null;
  /** The cause alone, without what was being read. */
  readonly reason: string;
  constructor(kind: LoadFail, message: string, code: string | null = null, reason: string = message) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.reason = reason;
  }
}

/** Why a read failed, as a sentence; never the raw code. */
export function failText(res: Got<unknown>): string {
  return failureText({ status: res.status, code: res.error?.code, detail: res.error?.detail }).text;
}

export async function get<T>(path: string): Promise<Got<T>> {
  const res = await request<T>('GET', path);
  return { status: res.status, body: res.status === 200 ? res.body : null, ...(res.error ? { error: res.error } : {}) };
}

/** Pages of a cursor-paged list (deliveries.py `_page`, at most 100 rows a page) from `cursor` on, as one reply; only the first unless `all`. A failed page fails it; `next` is the cursor left unread. */
async function pages<K extends string, T>(
  key: K,
  read: (query: string) => Promise<Got<Record<K, T[]> & { next_cursor: string | null }>>,
  all: boolean,
  cursor: string | null = null,
): Promise<Got<Record<K, T[]>> & { next: string | null }> {
  const rows: T[] = [];
  for (;;) {
    const res = await read(`limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!res.body) return { status: res.status, body: null, next: null, ...(res.error ? { error: res.error } : {}) };
    rows.push(...res.body[key]);
    cursor = res.body.next_cursor;
    if (!cursor || !all) return { status: 200, body: { [key]: rows } as Record<K, T[]>, next: cursor };
  }
}

/** Kinds of each reply; throws on a disconnect, or on any failure other than 404 (`what` names the read). */
function check(all: Array<Got<unknown>>, conn: AgentdConnection, what: string): Array<LoadFail | null> {
  const kinds = all.map((r) => classify(r, conn));
  if (kinds.includes('disconnected')) throw new TasksLoadError('disconnected', '后台服务已断开');
  const bad = all.find((_, i) => kinds[i] === 'other');
  if (bad) {
    const f = failureText({ status: bad.status, code: bad.error?.code, detail: bad.error?.detail });
    throw new TasksLoadError('other', `读取${what}失败：${f.text}`, f.code, f.text);
  }
  return kinds;
}

/** 待处理 as read: approvals and questions; reviews come with the task list. */
export interface PendingBase {
  approvals: Approval[];
  questions: Question[];
  offline?: boolean;
}

/** `/approvals` and `/agent/interactions` only, so the time-critical items never wait for the task list. */
export async function loadPending(): Promise<PendingBase> {
  const [conn, approvals, questions] = await Promise.all([
    getBridge().agentd.connection(),
    get<{ approvals: WireApproval[] }>('/approvals'),
    get<{ requests: WireInteraction[] }>('/agent/interactions'),
  ]);
  check([approvals, questions], conn, '待处理');
  const now = appNow();
  return {
    approvals: (approvals.body?.approvals ?? []).map((a) => fromApproval(a, now)),
    questions: (questions.body?.requests ?? []).map((q) => fromInteraction(q, now)),
    offline: conn === 'offline',
  };
}

/** The one cache entry for the pending approvals and questions; the task page and the shell read it. */
export const PENDING_KEY = ['tasks-pending'] as const;

export function usePending(enabled = true) {
  return useQuery({ queryKey: PENDING_KEY, queryFn: loadPending, enabled, retry: false, staleTime: Number.POSITIVE_INFINITY });
}

export type TasksList = Omit<TasksBase, 'approvals' | 'questions'>;

/** The list replies as read, so the later pages join the first. */
interface ListWire {
  rows: WireTaskRow[];
  versions: WireDelivery[];
  ledger: WireLedgerTask[];
  sessions: WireSession[];
  goals: WireGoal[];
  runs: WireRun[];
}

export interface TasksListPage extends TasksList {
  wire: ListWire;
  /** Cursors of the `/agent/tasks` and `/agent/deliveries` pages not read yet. */
  next: { tasks: string | null; deliveries: string | null };
}

function buildList(wire: ListWire, roleMissing: boolean, offline: boolean, next: TasksListPage['next']): TasksListPage {
  const { rows, ledger, runs } = wire;
  const sessions = wire.sessions.map(fromSession);
  const tasks = mergeTasks(
    rows.map((r) => fromTaskRow(r, ledger.find((l) => l.task_id === r.task_id), runs.find((x) => x.run_id === r.run_id))),
    ledger.map(fromLedgerTask),
    sessions,
  );
  const current = rows.flatMap((r) => (r.delivery ? [fromDelivery(r.delivery)] : []));
  const earlier = wire.versions.filter((d) => !current.some((c) => c.id === d.delivery_id)).map(fromDelivery);
  return {
    tasks,
    deliveries: [...current, ...earlier],
    sessions,
    goals: wire.goals.map((g) => fromGoal(g, tasks)),
    activeRuns: indexActiveRuns(runs, tasks),
    roleMissing,
    offline,
    wire,
    next,
  };
}

/** `?fail=1` picks the mock's 404 demo, `?demo=code-review` its coding tasks; real agentd answers an unknown query with 400 invalid_query. */
const roleQuery = (roleFail: boolean, demo: string | null) => (window.agenticComplex ? '' : roleFail ? 'fail=1&' : demo === 'code-review' ? 'demo=code-review&' : '');
const readRoles = (roleFail: boolean, demo: string | null) => (q: string) => get<{ tasks: WireTaskRow[]; next_cursor: string | null }>(`/agent/tasks?${roleQuery(roleFail, demo)}${q}`);
const readVersions = (q: string) => get<{ deliveries: WireDelivery[]; next_cursor: string | null }>(`/agent/deliveries?${q}`);

/** The task list's reads: `/agent/tasks` (current deliveries inline) and `/agent/deliveries` (the first page, or every page with `all`), `/tasks`, `/sessions`, `/agent/goals`, `/agent/runs`. */
export async function loadTasksList(roleFail: boolean, demo: string | null = null, all = false): Promise<TasksListPage> {
  const demoCode = demo === 'code-review' && !window.agenticComplex;
  const [conn, role, versions, ledger, sessions, goals, runs] = await Promise.all([
    getBridge().agentd.connection(),
    pages('tasks', readRoles(roleFail, demo), all),
    pages('deliveries', readVersions, all),
    get<{ tasks: WireLedgerTask[] }>(`/tasks${demoCode ? '?demo=code-review' : ''}`),
    get<{ sessions: WireSession[] }>('/sessions'),
    get<{ goals: WireGoal[] }>('/agent/goals'),
    get<{ runs: WireRun[] }>('/agent/runs'),
  ]);
  const kinds = check([role, versions, ledger, sessions, goals, runs], conn, '任务');
  const wire: ListWire = {
    rows: role.body?.tasks ?? [],
    versions: versions.body?.deliveries ?? [],
    ledger: ledger.body?.tasks ?? [],
    sessions: sessions.body?.sessions ?? [],
    goals: goals.body?.goals ?? [],
    runs: runs.body?.runs ?? [],
  };
  return buildList(wire, kinds[0] === 'not_found', conn === 'offline', { tasks: role.next, deliveries: versions.next });
}

/** The `/agent/tasks` and `/agent/deliveries` pages `first` left unread, joined to it. */
export async function loadRestOfList(first: TasksListPage, roleFail: boolean, demo: string | null = null): Promise<TasksListPage> {
  const none = { status: 200, body: null, next: null };
  const [conn, role, versions] = await Promise.all([
    getBridge().agentd.connection(),
    first.next.tasks ? pages('tasks', readRoles(roleFail, demo), true, first.next.tasks) : none,
    first.next.deliveries ? pages('deliveries', readVersions, true, first.next.deliveries) : none,
  ]);
  check([role, versions], conn, '任务');
  const w = first.wire;
  const wire = { ...w, rows: [...w.rows, ...(role.body?.tasks ?? [])], versions: [...w.versions, ...(versions.body?.deliveries ?? [])] };
  return buildList(wire, first.roleMissing, conn === 'offline', { tasks: null, deliveries: null });
}

/** The task list and the pending items as one TasksBase. */
export function joinTasks(list: TasksList, pending: PendingBase): TasksBase {
  const { tasks, deliveries, sessions, goals, activeRuns, roleMissing } = list;
  return { tasks, deliveries, sessions, goals, activeRuns, roleMissing, approvals: pending.approvals, questions: pending.questions, offline: !!list.offline || !!pending.offline };
}

/** Everything the task page lists, every page of it, in one read. */
export async function loadTasksBase(roleFail: boolean, demo: string | null = null): Promise<TasksBase> {
  const [list, pending] = await Promise.all([loadTasksList(roleFail, demo, true), loadPending()]);
  return joinTasks(list, pending);
}

