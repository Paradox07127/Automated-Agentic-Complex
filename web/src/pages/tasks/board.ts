// Task board: one card per role task or coding session of today, from the task view and `/day/segments`.
import { useQuery } from '@tanstack/react-query';
import { get } from '../../bridge/agentd';
import { formatDuration, secToMs, secToMsOrNull, type Task } from '../../domain';
import { pendingOf, type TasksView } from './model';

/** day_summary.py ledger session row (epoch seconds). */
interface WireDaySession {
  session_id: string;
  started_at: number | null;
  ended_at: number | null;
  last_gate: { at: number | null; passed: boolean } | null;
  guard_blocks: number;
}

/** day_summary.py own session row (epoch seconds). */
interface WireDayOwn {
  session_id: string;
  title: string | null;
  state: string;
  last_line: string | null;
  started_at: number;
  updated_at: number;
  task_id: string | null;
}

/** GET /day/segments?date= → {date, projects}. */
interface WireDaySegments {
  date: string;
  projects: Array<{ project: string; name: string | null; sessions: WireDaySession[]; own: WireDayOwn[] }>;
}

export interface DaySession {
  key: string;
  /** From a `claude:` / `codex:` session id; null for a bare uuid. */
  tool: 'claude' | 'codex' | null;
  dir: string | null;
  start: number | null;
  end: number | null;
  gate: { at: number; passed: boolean } | null;
  blocks: number;
}

export interface BoardData {
  sessions: DaySession[];
}

/** The session uuid ledger session ids and display sessions (`claude:<uuid>`) end with. */
export const uuidOf = (id: string | null | undefined): string | null => id?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0] ?? null;

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
export const startOfDay = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();

/** Today's ledger sessions; a failed read leaves them empty (the cards still come from the task view). */
export async function loadBoard(now: number): Promise<BoardData> {
  const [day] = await Promise.allSettled([get<WireDaySegments>(`/day/segments?date=${dayOf(now)}`)]);
  const sessions =
    day.status === 'fulfilled'
      ? day.value.projects.flatMap((p) =>
          p.sessions.map((s) => ({
            key: uuidOf(s.session_id) ?? s.session_id,
            tool: s.session_id.startsWith('codex:') ? ('codex' as const) : s.session_id.startsWith('claude:') ? ('claude' as const) : null,
            dir: p.name,
            start: secToMsOrNull(s.started_at),
            end: secToMsOrNull(s.ended_at),
            gate: s.last_gate?.at != null ? { at: secToMs(s.last_gate.at), passed: s.last_gate.passed } : null,
            blocks: s.guard_blocks,
          })),
        )
      : [];
  return { sessions };
}

export function useBoard(now: number, enabled: boolean) {
  return useQuery({ queryKey: ['tasks-board', dayOf(now)], queryFn: () => loadBoard(now), enabled, retry: false, staleTime: 30_000 });
}

export type CardTool = 'claude' | 'codex' | 'role';
export type CardStatus = 'wait' | 'err' | 'tool' | 'think' | 'idle' | 'done';

export const TOOL_LABEL: Record<CardTool, string> = { claude: 'Claude Code', codex: 'Codex', role: '角色任务' };

export interface BoardCard {
  id: string;
  /** The task row behind the card, null for a session only the ledger knows. */
  taskId: string | null;
  tool: CardTool;
  title: string;
  dir: string | null;
  status: CardStatus;
  stateText: string;
  first: number;
  /** Null while the card is live. */
  last: number | null;
  lastReply: string | null;
  goalId: string | null;
  /** Since when the current wait or idle state holds, when known. */
  since: number | null;
  gate: DaySession['gate'];
  stopped: boolean;
}

const toolOf = (t: Pick<Task, 'source' | 'target' | 'agent'>): CardTool => (t.source === 'role' ? 'role' : /codex/i.test(`${t.target ?? ''} ${t.agent ?? ''}`) ? 'codex' : 'claude');

const WAIT_TEXT = { approval: '待批准', question: '待回答', review: '待复核' } as const;

/** Which wait the card names when several are open. */
const WAIT_RANK = { approval: 0, review: 1, question: 2 } as const;

function statusOf(t: Task, view: TasksView): { status: CardStatus; text: string; since: number | null } {
  const eff = view.effective[t.id];
  const ses = view.sessions.find((s) => s.task_id === t.id);
  if (eff === 'waiting') {
    const p = pendingOf(view, t.id);
    const first = [...p].sort((a, b) => WAIT_RANK[a.kind] - WAIT_RANK[b.kind])[0];
    return { status: 'wait', text: first ? WAIT_TEXT[first.kind] : '待处理', since: p.length > 0 ? Math.min(...p.map((x) => x.since)) : null };
  }
  if (eff === 'failed') return { status: 'err', text: '执行失败', since: null };
  if (eff === 'done') return { status: 'done', text: '已完成', since: null };
  if (eff === 'stopped') return { status: 'done', text: '已停止', since: null };
  if (eff === 'idle') return { status: 'idle', text: '空闲', since: ses?.since ?? null };
  const run = view.activeRuns[t.id];
  if (run?.state === 'thinking' || ses?.state === 'thinking') return { status: 'think', text: '思考中', since: null };
  return { status: 'tool', text: run?.tool ? `工具执行中 │ ${run.tool}` : '进行中', since: null };
}

/** Cards active today: every task row, then ledger sessions no row covers. */
export function buildCards(view: TasksView, board: BoardData | undefined, now: number): BoardCard[] {
  const today = startOfDay(now);
  const sessions = board?.sessions ?? [];
  const used = new Set<string>();
  const out: BoardCard[] = [];
  for (const t of view.tasks) {
    const own = view.sessions.find((s) => s.task_id === t.id);
    const key = uuidOf(t.id) ?? uuidOf(own?.display_session);
    const day = key ? sessions.find((s) => s.key === key) : undefined;
    if (key) used.add(key);
    const st = statusOf(t, view);
    const live = !['done', 'err'].includes(st.status);
    const first = Math.min(t.started_at ?? t.created_at, day?.start ?? Number.POSITIVE_INFINITY);
    const last = live ? null : (t.ended_at ?? day?.end ?? t.updated_at);
    if ((last ?? now) < today) continue;
    out.push({
      id: t.id,
      taskId: t.id,
      tool: toolOf(t),
      title: t.title,
      dir: t.source === 'role' ? null : (t.cwd ?? own?.cwd ?? day?.dir ?? null),
      ...st,
      stateText: st.status === 'idle' ? `空闲 │ ${formatDuration(now - (st.since ?? t.updated_at))}` : st.text,
      first,
      last,
      lastReply: own?.last_line ?? t.failure?.reason ?? t.summary ?? null,
      goalId: t.goal_id ?? null,
      gate: day?.gate ?? null,
      stopped: view.effective[t.id] === 'stopped',
    });
  }
  for (const s of sessions) {
    if (used.has(s.key) || s.start == null) continue;
    used.add(s.key);
    const ended = s.end != null && now - s.end > 10 * 60_000;
    // A failed gate is the session's own business, not a failure of the session.
    const base = ended ? { status: 'done' as const, stateText: '已完成' } : { status: 'tool' as const, stateText: '执行中' };
    out.push(sessionCard(`ses:${s.key}`, s, base.status, base.stateText, now));
  }
  return out;
}

function sessionCard(id: string, s: DaySession, status: CardStatus, stateText: string, now: number): BoardCard {
  const start = s.start ?? now;
  return {
    id,
    taskId: null,
    tool: s.tool ?? 'claude',
    title: `${TOOL_LABEL[s.tool ?? 'claude']} 会话`,
    dir: s.dir,
    status,
    stateText,
    first: start,
    last: status === 'done' || status === 'err' ? (s.end ?? now) : null,
    lastReply: null,
    goalId: null,
    since: null,
    gate: s.gate,
    stopped: false,
  };
}

const ORDER: Record<CardStatus, number> = { wait: 0, err: 1, tool: 2, think: 3, idle: 4, done: 5 };

/** Waiting and failed first, then running, idle and finished; newest first within each. */
export const sortCards = (cards: readonly BoardCard[]) => [...cards].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.first - a.first);
