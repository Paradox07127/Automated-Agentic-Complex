import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type AgentdConnection } from '../../bridge';
import { AgentdCallError, get, seg } from '../../bridge/agentd';
import { appNow } from '../../bridge/clock';
import { refreshRuntime } from '../../data/runtime';
import { TasksLoadError, type TasksBase } from '../../data/tasksBase';
import {
  fromConversation,
  fromDelivery,
  fromInteraction,
  fromRuntimePublic,
  fromTaskRow,
  indexActiveRuns,
  turnsToMessages,
  type Conversation,
  type Message,
  type Plan,
  type StepStatus,
  type WireConversation,
  type WireInteraction,
  type WireLedgerTask,
  type WireRun,
  type WireRunItem,
  type WireRuntimePublic,
  type WireTaskRow,
  type WireTurn,
} from '../../domain';
import { failureText } from '../../domain/errorText';

export const clock = appNow;

/** Demo query parameters go to the fake bridge only; agentd answers an unknown query with 400. */
export const demoQuery = (on: boolean, q: string) => (on && !window.agenticComplex ? q : '');

/** A failed read: `offline` (or an offline agentd) is a disconnect, anything else says why in words. */
export function loadError(e: unknown, conn: AgentdConnection, what: string): TasksLoadError {
  const code = e instanceof AgentdCallError ? e.code : null;
  if (conn === 'offline' || code === 'offline') return new TasksLoadError('disconnected', `${what}：后台服务已断开`);
  const f = e instanceof AgentdCallError ? failureText(e) : { text: '后台服务没有响应', code: null };
  return new TasksLoadError(e instanceof AgentdCallError && e.status === 404 ? 'not_found' : 'other', `${what}：${f.text}`, f.code);
}

export interface ConvIndex {
  /** Not archived, pinned first then newest; the active row carries the top-level `busy`. */
  conversations: Conversation[];
  archived: Conversation[];
  /** agentd is running a turn or a line somewhere (control_panel `_busy`). */
  busy: boolean;
  /** agentd reported offline although the bridge still served this data. */
  offline: boolean;
}

/** `demo`: a fake-bridge query for a demo list (`?demo=sparse`), empty otherwise. */
export function useConversations(fail: boolean, enabled: boolean, demo = '') {
  return useQuery({
    queryKey: ['chat-convs', fail, demo],
    queryFn: async (): Promise<ConvIndex> => {
      const conn = await getBridge().agentd.connection();
      const body = await get<{ conversations: WireConversation[]; busy: boolean }>(`/conversations${demoQuery(fail, '?fail=1') || demo}`).catch((e: unknown) => {
        throw loadError(e, conn, '读取对话失败');
      });
      const now = clock();
      const rows = body.conversations.map((w) => fromConversation(w, now));
      return {
        conversations: rows.filter((c) => !c.archived).map((c) => (c.active ? { ...c, busy: body.busy } : c)),
        archived: rows.filter((c) => c.archived),
        busy: body.busy,
        offline: conn === 'offline',
      };
    },
    enabled,
    retry: false,
    staleTime: 5_000,
    refetchOnMount: 'always',
  });
}

interface TurnsPage {
  turns: WireTurn[];
  before: number | null;
}

/** `GET /conversations/{id}/turns`, newest page first; `fetchNextPage` reads the page before the oldest one. */
export function useTurns(id: string | null) {
  const q = useInfiniteQuery({
    queryKey: ['chat-turns', id],
    queryFn: ({ pageParam }) => get<TurnsPage>(`/conversations/${seg(id ?? '')}/turns${pageParam != null ? `?before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last: TurnsPage) => last.before,
    enabled: id != null,
    retry: false,
    staleTime: 5_000,
    refetchOnMount: 'always',
  });
  const pages = q.data?.pages ?? [];
  const turns = [...pages].reverse().flatMap((p) => p.turns);
  const messages: Message[] = turnsToMessages(turns);
  const turnIds = new Set(turns.flatMap((t) => (t.turn_id ? [t.turn_id] : [])));
  return { query: q, messages, turnIds };
}

export interface ChatTasks {
  base: TasksBase;
  /** Conversation of every listed run, for requests that name only their run. */
  runConversation: Record<string, string>;
  /** A foreground run (not `bg-`) is running anywhere: agentd answers a new line in a side session. */
  frontRunning: boolean;
  /** The selected conversation's current model run, even when it has no task card. */
  activeTurn?: Pick<WireRun, 'run_id' | 'generation'>;
}

/** Every page of the conversation's `/agent/tasks` (deliveries.py `_page`, at most 100 rows a page). */
async function conversationTasks(conv: string): Promise<WireTaskRow[]> {
  const rows: WireTaskRow[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ conversation_id: conv, limit: '100', ...(cursor ? { cursor } : {}) });
    const page: { tasks: WireTaskRow[]; next_cursor: string | null } = await get(`/agent/tasks?${q.toString()}`);
    rows.push(...page.tasks);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
}

/** A foreground line is running; `bg-` jobs and the observation `semantic-` runs (services/semantic.py) have their own sessions. */
export const frontRunning = (runs: ReadonlyArray<{ run_id: string; state: string }>): boolean =>
  runs.some((r) => r.state === 'running' && !r.run_id.startsWith('bg-') && !r.run_id.startsWith('semantic-'));

/** The three reads behind the inline task, its panel and the conversation's requests (`/agent/runs` gives the live run). */
export function useChatTasks(conv: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['chat-tasks', conv],
    queryFn: async (): Promise<ChatTasks> => {
      const conn = await getBridge().agentd.connection();
      const [tasks, interactions, runs, ledger] = await Promise.all([
        conversationTasks(conv ?? ''),
        get<{ requests: WireInteraction[] }>('/agent/interactions'),
        get<{ runs: WireRun[] }>('/agent/runs'),
        get<{ tasks: WireLedgerTask[] }>('/tasks'),
      ]).catch((e: unknown) => {
        throw loadError(e, conn, '读取任务失败');
      });
      const now = clock();
      const rows = tasks.map((r) => fromTaskRow(r, ledger.tasks.find((t) => t.task_id === r.task_id), runs.runs.find((x) => x.run_id === r.run_id)));
      const activeTurn = runs.runs.find((r) => r.conversation_id === conv && frontRunning([r]));
      return {
        base: {
          tasks: rows,
          deliveries: tasks.flatMap((r) => (r.delivery ? [fromDelivery(r.delivery)] : [])),
          sessions: [],
          approvals: [],
          questions: interactions.requests.map((w) => fromInteraction(w, now)),
          goals: [],
          activeRuns: indexActiveRuns(runs.runs, rows),
          roleMissing: false,
          offline: conn === 'offline',
        },
        runConversation: Object.fromEntries(runs.runs.map((r) => [r.run_id, r.conversation_id])),
        frontRunning: frontRunning(runs.runs),
        ...(activeTurn ? { activeTurn } : {}),
      };
    },
    enabled: enabled && conv != null,
    retry: false,
    staleTime: 5_000,
    refetchOnMount: 'always',
    refetchInterval: (query) => query.state.data?.frontRunning || Object.keys(query.state.data?.base.activeRuns ?? {}).length > 0 ? 3_000 : false,
  });
}

/** Plan steps as agentd stores and sends them (runtime.py plan(): `{text, status}`, at most 32). */
export const planSteps = (steps: ReadonlyArray<{ text: string; status: string }>): Plan['steps'] =>
  steps.map((s) => ({ text: s.text, status: s.status as StepStatus, since: null }));

export function useRunItems<T = WireRunItem[]>(runId: string | null, select?: (items: WireRunItem[]) => T, running = false) {
  return useQuery({
    queryKey: ['chat-run-items', runId],
    queryFn: async () => (await get<{ items: WireRunItem[] }>(`/agent/runs/${seg(runId ?? '')}/items`)).items,
    enabled: runId != null,
    retry: false,
    staleTime: 5_000,
    refetchInterval: running ? 3_000 : false,
    ...(select ? { select } : {}),
  });
}

function savedPlan(items: WireRunItem[]): Plan | null {
  const item = items.findLast((i) => i.kind === 'plan' && Array.isArray(i.steps));
  // Only the live plan event carries a revision.
  return item ? { revision: 0, steps: planSteps(item.steps as Array<{ text: string; status: string }>), run_id: item.run_id, status: item.status } : null;
}

/** The run's saved plan, when the ledger has a plan item. */
export function usePlanSnapshot(runId: string | null, running = false) {
  return useRunItems(runId, savedPlan, running);
}
export interface ChatRuntime {
  wire: WireRuntimePublic;
  info: ReturnType<typeof fromRuntimePublic>;
}

/** How often an unready runtime is reread, in ms. */
const UNREADY_REREAD_MS = 3000;

/** `GET /character/runtime`: whether the role can answer, and the kernel chain when it cannot. */
export function useRuntime(loggedOutDemo: boolean, enabled: boolean) {
  const qc = useQueryClient();
  const key = ['chat-runtime', loggedOutDemo];
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<ChatRuntime> => {
      const wire = await get<WireRuntimePublic>(`/character/runtime${demoQuery(loggedOutDemo, '?demo=logged-out')}`);
      return { wire, info: fromRuntimePublic(wire) };
    },
    enabled,
    retry: false,
    // An unready kernel is reread on focus or remount: the user may have logged in elsewhere.
    staleTime: (q) => (q.state.data?.info.ready === false ? 0 : Number.POSITIVE_INFINITY),
    // A kernel still starting when the page opened turns ready without a focus change.
    refetchInterval: (q) => (q.state.data?.info.ready === false ? UNREADY_REREAD_MS : false),
  });
  /** 重新检测: the rescanning read, kept in this page's entry too. */
  const recheck = async (): Promise<ChatRuntime> => {
    const wire = await refreshRuntime(qc, loggedOutDemo ? 'logged-out' : null);
    const r = { wire, info: fromRuntimePublic(wire) };
    qc.setQueryData(key, r);
    return r;
  };
  return { query, recheck };
}

/** Composer inputs from the runtime: the selected kernel, it again only when not ready, and a usable other kernel. */
export function kernelState(r: ChatRuntime | undefined) {
  const info = r?.info ?? null;
  const selected = info?.runtimes.find((x) => x.id === info.selected) ?? null;
  const kernel = info && !info.ready ? selected : null;
  const alternative = info?.runtimes.find((x) => x.id !== info.selected && x.available !== false && x.authenticated !== false) ?? null;
  return { selected, kernel, alternative };
}

/** `/capabilities` share_screenshots (capabilities.py): why 附加窗口 cannot attach the window, or null when it can or nothing was read. */
export function lookOffReason(caps: { items: Record<string, { state: string; reason: string | null }> } | null): string | null {
  return caps?.items.share_screenshots?.reason === 'off' ? '隐私设置里没打开「屏幕识读」时附加截图' : null;
}

export function useLookOff(enabled: boolean) {
  return useQuery({
    queryKey: ['chat-look-off'],
    queryFn: async () => lookOffReason(await get<{ items: Record<string, { state: string; reason: string | null }> }>('/capabilities')),
    enabled,
    retry: false,
  });
}

/** The active character from the shell: its display name and id (replies by another character are signed with theirs). */
export function useRole() {
  return useQuery({
    queryKey: ['chat-role'],
    queryFn: async () => {
      const list = await getBridge().character.list();
      const active = list.find((c) => c.active);
      return { id: active?.id ?? null, name: active?.name ?? '角色', names: Object.fromEntries(list.map((c) => [c.id, c.name])) as Record<string, string> };
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
