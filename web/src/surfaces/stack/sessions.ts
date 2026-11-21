// Session stack model: presence session rows, the cards that sit on them, the folded pile.
import { isStackApproval, isWaiting, orderCards, type StackCard } from './model';

/** desktop_presence.py STATUSES, in the order agentd sorts the rows by. */
export type SessionStatus = 'needs_you' | 'error' | 'done' | 'running' | 'stale';

/** One presence `sessions[]` row; `updatedAt` in epoch ms. */
export interface SessionRow {
  id: string;
  backend: string;
  title: string;
  status: SessionStatus;
  /** A tool runs now; otherwise `tool` and `target` are the last one's. */
  live: boolean;
  /** desktop_presence.py LABELS for its state, e.g. 思考中. */
  activity: string;
  tool: string | null;
  target: string | null;
  updatedAt: number;
  /** Broker approval ids waiting on this session. */
  approvals: string[];
}

export interface SessionGroup {
  row: SessionRow;
  /** `needs_you` as soon as a waiting card sits on it, else the row's own status. */
  status: SessionStatus;
  cards: StackCard[];
}

const STATUSES = new Set<string>(['needs_you', 'error', 'done', 'running', 'stale']);

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** The rows of agentd's `/desktop/presence` as native forwards it; `more` is `additional_sessions`. */
export function presenceSessions(raw: unknown): { rows: SessionRow[]; more: number } {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rows = (Array.isArray(p.sessions) ? p.sessions : []).flatMap((s): SessionRow[] => {
    if (!s || typeof s !== 'object') return [];
    const r = s as Record<string, unknown>;
    const id = str(r.id);
    if (!id) return [];
    const status = str(r.status);
    return [
      {
        id,
        backend: str(r.backend) ?? '',
        title: str(r.title) || id,
        status: status && STATUSES.has(status) ? (status as SessionStatus) : 'running',
        live: r.state === 'running_tool',
        activity: str(r.activity) ?? '',
        tool: str(r.tool),
        target: str(r.target),
        updatedAt: typeof r.updated_at === 'number' ? r.updated_at * 1000 : 0,
        approvals: Array.isArray(r.approvals) ? r.approvals.filter((a): a is string => typeof a === 'string') : [],
      },
    ];
  });
  const more = typeof p.additional_sessions === 'number' && p.additional_sessions > 0 ? Math.floor(p.additional_sessions) : 0;
  return { rows, more };
}

/** Cards the chat window shows: every notice but 电脑操作. app/electron stack-source.ts `isChatCard` is the same rule. */
export function isChatCard(c: StackCard): boolean {
  return c.kind === 'notice' && c.variant !== 'computer';
}

function belongs(c: StackCard, row: SessionRow): boolean {
  if (c.kind !== 'approval' && c.kind !== 'question') return false;
  if (row.approvals.includes(c.id)) return true;
  return c.kind === 'approval' && (c.item.display_session === row.id || c.item.session_id === row.id);
}

/**
 * Approvals and questions a session claims sit on it; the other stack cards stay standalone in `orderCards` order.
 * Chat cards are left out unless `restored` (brought back from history) names them. Sessions keep presence's order,
 * except that one with a waiting card goes up with the other `needs_you` rows: the card can arrive before presence says so.
 */
export function groupStack(cards: readonly StackCard[], rows: readonly SessionRow[], restored: readonly string[] = []) {
  const attached = new Map<string, StackCard[]>();
  const standalone: StackCard[] = [];
  for (const c of cards) {
    if (isChatCard(c) && !restored.includes(c.id)) continue;
    const r = rows.find((x) => belongs(c, x));
    if (r) {
      if (r.status === 'done' && isStackApproval(c)) continue;
      attached.set(r.id, [...(attached.get(r.id) ?? []), c]);
    } else standalone.push(c);
  }
  const groups = rows.map((r): SessionGroup => {
    const own = orderCards(attached.get(r.id) ?? []);
    return { row: r, status: own.some(isWaiting) ? 'needs_you' : r.status, cards: own };
  });
  return {
    standalone: orderCards(standalone),
    sessions: [...groups.filter((g) => g.status === 'needs_you'), ...groups.filter((g) => g.status !== 'needs_you')],
  };
}

/** Folded, the edges of at most this many sessions show behind the top one. */
export const PILE_EDGES = 2;

/** Sessions on screen: folded, the top one with `edges` behind it and `extra` for the rest; expanded, all the rows presence sent. */
export function pile(groups: readonly SessionGroup[], more: number, expanded: boolean) {
  if (expanded) return { shown: [...groups], edges: 0, extra: more };
  const edges = Math.min(PILE_EDGES, Math.max(0, groups.length - 1));
  return { shown: groups.slice(0, 1), edges, extra: Math.max(0, groups.length - 1 - edges) + more };
}
