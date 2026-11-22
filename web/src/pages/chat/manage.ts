import type { Conversation } from '../../domain';
import type { MenuItem } from '../../ui';

export interface ManageActions {
  restore: () => void;
  pin: () => void;
  archive: () => void;
  rename: () => void;
  remove: () => void;
}

/** A topic row's right-click menu; deleting, or archiving the active one, waits for the role. */
export function manageItems(c: Conversation, busy: boolean, a: ManageActions): MenuItem[] {
  const del = (hint?: string): MenuItem => ({ kind: 'item', label: '删除…', ...(hint ? { hint } : {}), danger: true, disabled: busy, reason: '角色执行中，结束后可删除', onSelect: a.remove });
  return c.archived
    ? [{ kind: 'item', label: '恢复', onSelect: a.restore }, { kind: 'sep' }, del()]
    : [
        { kind: 'item', label: c.pinned ? '取消置顶' : '置顶', onSelect: a.pin },
        { kind: 'item', label: '重命名', hint: 'F2', onSelect: a.rename },
        { kind: 'item', label: '归档', disabled: busy && c.active, reason: '角色执行中，结束后可归档', onSelect: a.archive },
        { kind: 'sep' },
        del('⌫'),
      ];
}
