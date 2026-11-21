// ⏎ / esc on the top card when the stack panel is key and focus is on no control.
import { approvalView } from '../../features/approval/approvalView';
import { isStackApproval, type StackCard } from './model';

export type StackKeyAction =
  /** `generation` is the approval's token: broker generation or interaction revision. */
  | { type: 'decide'; id: string; decision: 'allow' | 'deny'; generation: number }
  | { type: 'danger-hint'; id: string }
  | { type: 'open-delivery'; id: string }
  | { type: 'dismiss'; id: string }
  | { type: 'collapse'; id: string };

/** Which keycaps a card shows; a card without keyboard behaviour shows none. */
export function keycapsFor(c: StackCard): { esc: boolean; enter: boolean } {
  if (isStackApproval(c)) {
    const view = approvalView(c);
    return view.outcome ? { esc: false, enter: false } : { esc: true, enter: !view.dangerous };
  }
  switch (c.kind) {
    case 'delivery':
      return { esc: true, enter: true };
    case 'error':
      return { esc: true, enter: false };
    case 'notice':
      return { esc: c.variant === 'reminder', enter: false };
    default:
      return { esc: false, enter: false };
  }
}

/** The action ⏎ or esc takes on the top card; a dangerous approval never approves from the keyboard. */
export function keyActionFor(top: StackCard | undefined, key: string): StackKeyAction | null {
  if (!top || top.receipt || (key !== 'Enter' && key !== 'Escape')) return null;
  const view = isStackApproval(top) ? approvalView(top) : null;
  if (view?.outcome) return null;
  const caps = keycapsFor(top);
  if (key === 'Escape' && !caps.esc) return null;
  if (view) {
    const generation = view.token;
    if (key === 'Escape') return { type: 'decide', id: top.id, decision: 'deny', generation };
    return view.dangerous ? { type: 'danger-hint', id: top.id } : caps.enter ? { type: 'decide', id: top.id, decision: 'allow', generation } : null;
  }
  // A reminder only folds; 完成 is its own button.
  if (key === 'Escape') return top.kind === 'notice' && top.variant === 'reminder' ? { type: 'collapse', id: top.id } : { type: 'dismiss', id: top.id };
  if (top.kind === 'delivery') return { type: 'open-delivery', id: top.id };
  return null;
}
