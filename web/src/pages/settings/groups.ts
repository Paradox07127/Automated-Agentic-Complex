/** Settings groups. */
export const SETTING_GROUPS: Array<{ title: string; items: Array<{ id: string; label: string }> }> = [
  { title: '交互', items: [{ id: 'speak', label: '说话与通知' }, { id: 'keys', label: '快捷键' }] },
  { title: '智能体', items: [{ id: 'kernel', label: '角色内核' }, { id: 'model', label: 'pi 账号与凭据' }] },
  {
    title: '隐私与安全',
    items: [
      { id: 'privacy', label: '隐私' },
      { id: 'perm', label: '权限与授权' },
      { id: 'data', label: '数据' },
    ],
  },
  { title: '系统', items: [{ id: 'about', label: '启动与关于' }, { id: 'adv', label: '高级' }] },
];

/** 「设置 › <分组标签>」 for a group id, the path hints name. */
export function settingPath(id: string): string {
  const label = SETTING_GROUPS.flatMap((g) => g.items).find((i) => i.id === id)?.label;
  return label ? `设置 › ${label}` : '设置';
}
