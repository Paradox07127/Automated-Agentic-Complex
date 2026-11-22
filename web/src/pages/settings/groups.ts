import type { GroupId } from './registry';

/** Settings groups in tab order, by what the user comes for; `desc` is the ⓘ on the group's first section. */
export const SETTING_GROUPS: Array<{ id: GroupId; label: string; desc: string }> = [
  { id: 'speak', label: '说话', desc: '她出不出声、什么时候主动开口、事情怎么告诉你' },
  { id: 'perm', label: '能做', desc: '她可以替你动手做哪些事，要你允许哪些系统权限' },
  { id: 'privacy', label: '观察', desc: '她能读你屏幕上的什么，什么会离开这台电脑' },
  { id: 'kernel', label: '内核', desc: '她用什么动手，所有角色共用；她是谁由角色卡决定' },
  { id: 'model', label: '账号', desc: '内核用哪个模型服务、用谁的账号' },
  { id: 'keys', label: '按键', desc: '在任何应用里叫她的全局快捷键' },
  { id: 'data', label: '数据', desc: '留多久、在哪、怎么删' },
  { id: 'about', label: '关于', desc: '启动、版本、排障' },
];

/** 「设置 › <分组>」 for a group id, the path hints name. */
export function settingPath(id: string): string {
  const label = SETTING_GROUPS.find((g) => g.id === id)?.label;
  return label ? `设置 › ${label}` : '设置';
}

export const groupDesc = (id: GroupId): string => SETTING_GROUPS.find((g) => g.id === id)?.desc ?? '';
