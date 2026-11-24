import type { PendingItem } from '../../domain';

export const KIND_LABEL: Record<PendingItem['kind'], string> = { approval: '审批', question: '提问', review: '复核' };

/** One request's identity: a card keyed by it starts with fresh decision state and buttons when the request changes. */
export const requestKey = (item: PendingItem) => `${item.kind}:${item.id}:${item.generation}`;

/** Seconds left at `now`, counted down from the snapshot time; null = no deadline. */
export function leftAt(item: PendingItem, now: number, at: number): number | null {
  if (item.kind === 'review' || item.seconds_left == null) return null;
  return Math.max(0, item.seconds_left - Math.floor((now - at) / 1000));
}

/** An approval whose window ran out: no longer waiting for the user, so it leaves the 待处理 count. */
export function isExpired(item: PendingItem, now: number, at: number): boolean {
  return item.kind === 'approval' && leftAt(item, now, at) === 0;
}

/** The item decided in place: the first one still open. */
export function focusOf(items: readonly PendingItem[], now: number, at: number): PendingItem | null {
  return items.find((x) => !isExpired(x, now, at)) ?? null;
}
