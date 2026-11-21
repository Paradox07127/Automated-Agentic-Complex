import type { Conversation } from '../../domain';
import type { MenuItem } from '../../ui';

export interface ManageActions {
  restore: () => void;
  pin: () => void;
  archive: () => void;
  rename: () => void;
  remove: () => void;
}

/** 管理对话 menu (header ⋯ and a row's right click); deleting or archiving the active one waits for the role. */
export function manageItems(c: Conversation, busy: boolean, a: ManageActions): MenuItem[] {
  const del: MenuItem = { kind: 'item', label: '删除…', danger: true, disabled: busy, reason: '角色执行中，结束后可删除', onSelect: a.remove };
  return c.archived
    ? [{ kind: 'item', label: '恢复', onSelect: a.restore }, { kind: 'sep' }, del]
    : [
        { kind: 'item', label: '重命名', onSelect: a.rename },
        { kind: 'item', label: c.pinned ? '取消置顶' : '置顶', onSelect: a.pin },
        { kind: 'item', label: '归档', disabled: busy && c.active, reason: '角色执行中，结束后可归档', onSelect: a.archive },
        { kind: 'sep' },
        del,
      ];
}
