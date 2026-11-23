import type { GroupId } from './registry';

/** Settings groups in tab order, by what the user comes for; `desc` says in one line what the tab holds. */
export const SETTING_GROUPS: Array<{ id: GroupId; label: string; desc: string }> = [
  { id: 'speak', label: '说话', desc: '出不出声、什么时候主动开口、事情怎么告诉你' },
  { id: 'perm', label: '能做', desc: '角色可以替你动手做哪些事，要你允许哪些系统权限' },
  { id: 'privacy', label: '观察', desc: '角色能读你屏幕上的什么，什么会离开这台电脑' },
  { id: 'display', label: '显示', desc: '角色的画面、镜头、帧率和场景在哪里调，录屏时隐不隐藏' },
  { id: 'kernel', label: 'AI', desc: '谁来回答、用谁的账号、用哪个模型，所有角色共用' },
  { id: 'services', label: '服务', desc: '自建的语音、动作和模型接口怎么接、开没开' },
  { id: 'keys', label: '按键', desc: '在任何应用里叫出角色的全局快捷键' },
  { id: 'data', label: '数据', desc: '留多久、在哪、怎么删' },
  { id: 'about', label: '关于', desc: '启动、版本、排障' },
];

/** 「设置 › <分组>」 for a group id, the path hints name. */
export function settingPath(id: string): string {
  const label = SETTING_GROUPS.find((g) => g.id === id)?.label;
  return label ? `设置 › ${label}` : '设置';
}
