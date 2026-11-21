// Desktop floating-card stack model. Pure data and ordering rules.
import type { DesktopStackCard } from '../../bridge/protocol';
import { sortPending, type PendingCard, type StackCard as DomainStackCard } from '../../domain';
import { approvalView, isApprovalCard, type ApprovalStackItem } from '../../features/approval/approvalView';

export type { NoticeVariant, PendingCard } from '../../domain';
export type { DesktopStackCard, StackHistoryEntry, StackPayload } from '../../bridge/protocol';

/** The domain cards and the notices native raises itself (电脑操作, 语音提示, 角色加载). */
export type StackCard = DomainStackCard | DesktopStackCard;

export type Priority = 0 | 1 | 2 | 3;

/** A broker approval or a role approval; native's own notices never are. */
export function isStackApproval(c: StackCard): c is ApprovalStackItem {
  return (c.kind === 'approval' || c.kind === 'question') && isApprovalCard(c);
}

/** A broker or role approval the policy judged dangerous. */
const isDangerous = (c: StackCard) => isStackApproval(c) && approvalView(c).dangerous;

export function isPending(c: StackCard): c is PendingCard {
  return c.kind === 'approval' || c.kind === 'question' || c.kind === 'review';
}

/**
 * P0 safety, P1 decision, P2 notification, P3 hint.
 * 电脑操作 is P0 (its 停止 must stay reachable); 角色加载 P2; 语音提示, 屏幕识读, 提醒 and 简报 P3.
 */
export function priorityOf(c: StackCard): Priority {
  if (isStackApproval(c)) return isDangerous(c) ? 0 : 1;
  switch (c.kind) {
    case 'question':
    case 'review':
      return 1;
    case 'notice':
      if (c.variant === 'computer') return 0;
      return c.variant === 'reminder' || c.variant === 'look' || c.variant === 'brief' || c.variant === 'voice' ? 3 : 2;
    default:
      return 2;
  }
}

export const ELSEWHERE_RECEIPT_MS = 3200;

/** A card still waiting for the user: unresolved pending item without a receipt. */
export function isWaiting(c: StackCard): boolean {
  if (!isPending(c) || c.receipt) return false;
  return !(isStackApproval(c) && approvalView(c).outcome);
}

/**
 * P0 notices (电脑操作) first, then pending cards in `sortPending` order (approvals with ≤ 10 s left, then danger,
 * then less time left, then kind, then waited longer), then the other notices by priority, newest first.
 */
export function orderCards(cards: readonly StackCard[]): StackCard[] {
  const pending = sortPending(
    cards.filter(isPending).map((c) => ({
      c,
      dangerous: isDangerous(c),
      seconds_left: c.kind === 'review' ? null : c.item.seconds_left,
      kind: isStackApproval(c) ? 'approval' : c.kind,
      since: c.item.since,
    })),
  ).map((x) => x.c);
  const notices = cards.filter((c) => !isPending(c)).sort((a, b) => priorityOf(a) - priorityOf(b) || b.at - a.at);
  return [...notices.filter((c) => priorityOf(c) === 0), ...pending, ...notices.filter((c) => priorityOf(c) > 0)];
}

/**
 * Open cards on screen. Folded, every P0 card (safety, always in full) and the first other one, which shows compact;
 * expanded, all of them. P0 cards are first in `ordered` already.
 */
export function visibleCards(ordered: readonly StackCard[], showAll: boolean): StackCard[] {
  const open = ordered.filter((c) => !c.collapsed);
  if (showAll) return open;
  const first = open.find((c) => priorityOf(c) > 0);
  return open.filter((c) => priorityOf(c) === 0 || c === first);
}

/** Title used in the history list and toasts. */
export function cardTitle(c: StackCard): string {
  switch (c.kind) {
    case 'approval':
    case 'question':
    case 'review':
      return c.item.title;
    case 'delivery':
    case 'error':
    case 'notice':
      return c.title;
  }
}
