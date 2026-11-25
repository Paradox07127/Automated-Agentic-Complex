import type { NavTarget } from '../../shell/nav';
import type { PluginId } from '../../shell/plugins';
import type { IconName } from '../../ui';

/** What a key does in place, rather than open a page. */
export type ActId = 'dispatch' | 'search' | 'quickInput' | 'look' | 'stopSpeech';

/** A key of the right-hand list. An action whose plug-in is off is off with its 已关闭 reason; a page key whose plug-in
 *  is off keeps its place with the 已关闭 mark and still opens the page. */
export interface RightSpec {
  id: string;
  icon: IconName;
  /** The tab's own name where it says enough by itself. */
  title: string;
  hotkey?: string;
  plugin?: PluginId;
  /** Only in 开发者模式; out of it the keys after move up. */
  dev?: true;
  act?: ActId;
  to?: NavTarget;
}

/** Top to bottom, two a row: the actions, the sub-views used most, settings, then the developer views. */
export const RIGHT: readonly RightSpec[] = [
  { id: 'dispatch', icon: 'plus', title: '派发任务', hotkey: '⌘N', plugin: 'personal_agent', act: 'dispatch' },
  { id: 'search', icon: 'search', title: '搜索', hotkey: '⌘K', act: 'search' },
  { id: 'quickInput', icon: 'bolt', title: '快速输入', act: 'quickInput' },
  { id: 'look', icon: 'look', title: '屏幕识读', plugin: 'screen_reading', act: 'look' },
  { id: 'stopSpeech', icon: 'stop', title: '停止说话', act: 'stopSpeech' },
  { id: 'sched', icon: 'clock', title: '定时', plugin: 'personal_agent', to: { page: 'tasks', tab: 'sched' } },
  { id: 'facts', icon: 'file', title: '档案', to: { page: 'memory', view: 'about' } },
  { id: 'activity', icon: 'history', title: '回顾', plugin: 'screen_awareness', to: { page: 'memory', view: 'activity' } },
  { id: 'outfit', icon: 'g-image', title: '外观', to: { page: 'character', pane: 'look' } },
  { id: 'motions', icon: 'play', title: '动作表', to: { page: 'character', pane: 'motion' } },
  { id: 'mmd', icon: 'radio', title: 'MMD', to: { page: 'mmd' } },
  { id: 'her', icon: 'user', title: '角色这一天', plugin: 'daily_brief', to: { page: 'overview', tab: 'char' } },
  // 每日简报 has its 时间 tab only while 屏幕感知 is on (agentd's brief focus.enabled).
  { id: 'time', icon: 'g-trace', title: '时间', plugin: 'daily_brief', to: { page: 'overview', tab: 'tm' } },
  { id: 'perm', icon: 'hand', title: '能力', to: { page: 'settings', group: 'perm' } },
  { id: 'privacy', icon: 'privacy', title: '感知', to: { page: 'settings', group: 'privacy' } },
  { id: 'diag', icon: 'd-overview', title: '诊断', dev: true, to: { page: 'diag', tab: 'overview' } },
  { id: 'turns', icon: 'g-chat', title: '对话轮次', dev: true, to: { page: 'diag', tab: 'turns' } },
  { id: 'logs', icon: 'data', title: '日志', dev: true, to: { page: 'diag', tab: 'logs' } },
  { id: 'pipeline', icon: 'hub', title: '管线', dev: true, to: { page: 'memory', view: 'pipeline' } },
];
