import { navigate } from '../../shell/nav';
import type { MenuItem } from '../../ui';
import type { ChatCharacter } from './useChatData';

/** The right-click menu of a character's tab. `working`: agentd refuses a new topic for the character on the desktop meanwhile. */
export function tabMenu(c: ChatCharacter, present: string | null, working: boolean, onNew: () => void, onSwap: () => void): MenuItem[] {
  return [
    { kind: 'item', label: '新话题', disabled: c.id === present && working, reason: '角色执行中，结束后可新建', onSelect: onNew },
    { kind: 'item', label: `换${c.name}出来`, disabled: c.id === present, reason: `${c.name}已在桌面`, onSelect: onSwap },
    { kind: 'item', label: `${c.name}的专属记忆`, onSelect: () => navigate({ page: 'memory', view: 'about', owner: c.id }) },
  ];
}
