import type { GroupId } from './registry';

/** Settings groups in tab order, by what the user comes for; `desc` says in one line what the tab holds. */
export const SETTING_GROUPS: Array<{ id: GroupId; label: string; desc: string }> = [
  { id: 'speak', label: '交流', desc: '配置语音播报、主动交互策略与通知送达方式' },
  { id: 'perm', label: '能力', desc: '配置角色可执行的系统能力与所需系统权限' },
  { id: 'privacy', label: '感知', desc: '管理屏幕读取范围与数据外发策略' },
  { id: 'display', label: '显示', desc: '调整角色外观、镜头、帧率及录屏保护策略' },
  { id: 'kernel', label: '内核', desc: '配置对话与任务使用的执行内核、账号及模型（所有角色共用）' },
  { id: 'services', label: '服务', desc: '配置自建语音、动作与模型接口的连接及运行状态' },
  { id: 'keys', label: '快捷键', desc: '配置系统全局快捷键' },
  { id: 'data', label: '数据', desc: '管理数据保留周期、存储位置与本地数据清理' },
  { id: 'about', label: '关于', desc: '查看应用启动项、版本信息与排障工具' },
];

/** 「设置 › <分组>」 for a group id, the path hints name. */
export function settingPath(id: string): string {
  const label = SETTING_GROUPS.find((g) => g.id === id)?.label;
  return label ? `设置 › ${label}` : '设置';
}
