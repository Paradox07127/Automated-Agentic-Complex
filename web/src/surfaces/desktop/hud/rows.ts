// Status bar lines: one per live presence session and one per standalone card that waits on you.
import { formatSpan } from '../../../domain/time';
import { actionLine, approvalView, toolAction } from '../../../features/approval';
import { cardTitle, isStackApproval, isWaiting, type StackCard } from '../../stack/model';
import { ago } from '../../stack/SessionCard';
import { groupStack, presenceSessions, type SessionGroup, type SessionRow } from '../../stack/sessions';

export type HudStatus = 'waiting' | 'error' | 'running' | 'done' | 'stale';

/** A done line leaves the bar this long after the session finished. */
export const HUD_DONE_MS = 8000;

const RANK: Record<HudStatus, number> = { waiting: 0, error: 1, running: 2, done: 3, stale: 4 };

/** Inside 'waiting': approvals, then questions, then the rest (own-app waits, 电脑操作). */
const WAIT_APPROVAL = 0;
const WAIT_ANSWER = 1;
const WAIT_OTHER = 2;

const BACKEND_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', agentd: 'Agentic', character: 'Agentic' };

export interface HudRow {
  id: string;
  status: HudStatus;
  title: string;
  /** Verb first: what the session does now, or what the card asks. */
  action: string;
  /** Backend and running time, shown only expanded. */
  meta: string;
  /** The session this line opens; null for a standalone card. */
  session: SessionRow | null;
  /** The approvals, questions or 电脑操作 drawn under the line when expanded. */
  cards: StackCard[];
  /** Error card: the task its title opens. */
  task: string | null;
  /** Order among the waiting lines: WAIT_APPROVAL, WAIT_ANSWER or WAIT_OTHER. */
  waitRank: number;
}

/** Cards that wait on the user without a session: they get a line of their own. */
export function isHudCard(c: StackCard): boolean {
  return c.kind === 'approval' || c.kind === 'question' || c.kind === 'review' || c.kind === 'delivery' || c.kind === 'error' || (c.kind === 'notice' && c.variant === 'computer');
}

/** Info cards, which go to the ring's 结果 icon instead. */
export function isResultCard(c: StackCard): boolean {
  return c.kind === 'delivery' || c.kind === 'review' || (c.kind === 'notice' && (c.variant === 'done' || c.variant === 'brief' || c.variant === 'look' || c.variant === 'resume'));
}

/** `doing`, `started_at` (epoch ms) and `own_app`, and the session's `state`, per session id; agentd may not send them yet. */
function sessionExtras(raw: unknown): Map<string, { doing: string | null; startedAt: number | null; ownApp: boolean; state: string | null }> {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = new Map<string, { doing: string | null; startedAt: number | null; ownApp: boolean; state: string | null }>();
  for (const s of Array.isArray(p.sessions) ? p.sessions : []) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    if (typeof r.id !== 'string') continue;
    out.set(r.id, {
      doing: typeof r.doing === 'string' && r.doing ? r.doing : null,
      startedAt: typeof r.started_at === 'number' ? r.started_at * 1000 : null,
      ownApp: r.own_app === true,
      state: typeof r.state === 'string' ? r.state : null,
    });
  }
  return out;
}

/** A waiting session line: a waiting approval on it or its state first, then a waiting question or its state, then its approval ids. */
function sessionWait(g: SessionGroup, state: string | null): number {
  const waiting = g.cards.filter(isWaiting);
  if (waiting.some(isStackApproval) || state === 'awaiting_approval') return WAIT_APPROVAL;
  // Only approvals and questions sit on a session, so any other waiting card is a question.
  if (waiting.length > 0 || state === 'awaiting_input') return WAIT_ANSWER;
  return g.row.approvals.length > 0 ? WAIT_APPROVAL : WAIT_OTHER;
}

/** SessionCard's line: 「运行 swift test」 for the current or last tool, else the session's activity. */
function actionText(row: SessionRow): string {
  if (!row.tool) return row.activity;
  const a = toolAction(row.tool, row.target);
  return [a.verb, a.target].filter(Boolean).join(' ');
}

function cardRow(c: StackCard, now: number): HudRow {
  const base = { id: c.id, title: cardTitle(c), meta: ago(now, c.at), session: null, cards: [c], task: null, waitRank: WAIT_OTHER };
  if (isStackApproval(c)) {
    const view = approvalView(c);
    const line = actionLine(view);
    const what = [line.verb, line.target].filter(Boolean).join(' ');
    if (isWaiting(c)) return { ...base, status: 'waiting', action: what ? `待批准：${what}` : '待批准', waitRank: WAIT_APPROVAL };
    return { ...base, status: 'done', action: view.outcome?.text ?? c.receipt ?? '已处理' };
  }
  switch (c.kind) {
    case 'question':
      return { ...base, status: isWaiting(c) ? 'waiting' : 'done', action: isWaiting(c) ? '待回答' : (c.receipt ?? '已回答'), waitRank: isWaiting(c) ? WAIT_ANSWER : WAIT_OTHER };
    case 'review':
      return { ...base, status: isWaiting(c) ? 'waiting' : 'done', action: isWaiting(c) ? '待复核' : (c.receipt ?? '已处理') };
    case 'delivery':
      return { ...base, status: 'waiting', action: '交付待查看' };
    case 'error':
      return { ...base, status: 'error', action: c.reason ? `出错：${c.reason}` : '出错', cards: [], task: c.task_id };
    case 'notice':
      if (c.variant === 'computer') return { ...base, title: c.target_app ? `电脑操作「${c.target_app}」` : c.title, status: 'running', action: c.action };
  }
  return { ...base, status: 'running', action: '' };
}

/**
 * The bar's lines in order: waiting (approvals, then questions, then the rest), error, running, done, stale; standalone
 * cards before sessions of the same rank.
 */
export function hudRows(cards: readonly StackCard[], presence: unknown, now: number): HudRow[] {
  const live = presenceSessions(presence).rows.filter((r) => r.status !== 'done' || now - r.updatedAt < HUD_DONE_MS);
  const extras = sessionExtras(presence);
  const { standalone, sessions } = groupStack(cards, live);
  // As the stack's visibleCards: a card 收起 folded leaves the bar.
  const own = standalone.filter((c) => !c.collapsed && isHudCard(c)).map((c) => cardRow(c, now));
  const lines = sessions.map((g): HudRow => {
    const x = extras.get(g.row.id);
    const backend = BACKEND_LABEL[g.row.backend] ?? g.row.backend;
    const age = x?.startedAt != null ? `已 ${formatSpan(now - x.startedAt)}` : ago(now, g.row.updatedAt);
    const meta = [backend, age].filter(Boolean).join(' ');
    // Its own app holds the permission dialog; Agentic Complex cannot answer it, so the line only opens the session.
    if (x?.ownApp) return { id: g.row.id, status: 'waiting', title: g.row.title, action: `在 ${backend} 里等确认`, meta, session: g.row, cards: [], task: null, waitRank: WAIT_OTHER };
    return {
      id: g.row.id,
      status: g.status === 'needs_you' ? 'waiting' : g.status,
      title: g.row.title,
      action: x?.doing ?? actionText(g.row),
      meta,
      session: g.row,
      // A folded card leaves the bar here too; `g.status`, from all its cards, still says it waits.
      cards: g.cards.filter((c) => !c.collapsed),
      task: null,
      waitRank: g.status === 'needs_you' ? sessionWait(g, x?.state ?? null) : WAIT_OTHER,
    };
  });
  return [...own, ...lines].sort((a, b) => RANK[a.status] - RANK[b.status] || a.waitRank - b.waitRank);
}
