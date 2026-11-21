import type { PluginId } from '../../shell/plugins';

/** Settings groups; a group with a `plugin` shows only while that plug-in is on. */
export const SETTING_GROUPS: Array<{ title: string; items: Array<{ id: string; label: string; plugin?: PluginId }> }> = [
  { title: '插件', items: [{ id: 'plugins', label: '插件' }] },
  { title: '交互', items: [{ id: 'speak', label: '说话与通知' }, { id: 'keys', label: '快捷键' }] },
  { title: '智能体', items: [{ id: 'kernel', label: '角色内核', plugin: 'harness_bridge' }, { id: 'model', label: 'AI 账号' }] },
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
