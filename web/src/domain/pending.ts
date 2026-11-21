import type { PendingKind } from './states';
import { isUrgent } from './time';

/** Fields `sortPending` reads; `seconds_left` null or absent means no deadline. */
export interface PendingSortable {
  dangerous?: boolean;
  seconds_left?: number | null;
  kind?: PendingKind;
  /** When the item started waiting (epoch ms). */
  since: number;
}

const KIND_RANK: Record<PendingKind, number> = { approval: 0, question: 1, review: 2 };

function remaining(x: PendingSortable): number {
  return x.seconds_left == null ? Number.POSITIVE_INFINITY : x.seconds_left;
}

/** An approval that can still be decided and is about to time out. */
function urgentApproval(x: PendingSortable): boolean {
  return x.kind === 'approval' && isUrgent(x.seconds_left) && remaining(x) > 0;
}

function rank(x: PendingSortable): number {
  return x.kind == null ? KIND_RANK.review + 1 : KIND_RANK[x.kind];
}

/**
 * Pending order shared by overview, tasks › 待处理 and the desktop stack:
 * approvals with ≤ 10 s left first, then dangerous, then less time left, then kind (approval → question → review),
 * then waited longer. Urgent and dangerous ranks above urgent only; neither falls through to time left.
 * Returns a new array; ties keep input order.
 */
export function sortPending<T extends PendingSortable>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      Number(urgentApproval(b)) - Number(urgentApproval(a)) ||
      Number(!!b.dangerous) - Number(!!a.dangerous) ||
      remaining(a) - remaining(b) ||
      rank(a) - rank(b) ||
      a.since - b.since,
  );
}
