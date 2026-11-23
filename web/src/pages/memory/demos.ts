import type { Demo } from '../../shell/types';
import { v31Id } from '../../mock/fixtures/ids';

// Demo list: every state below must open by URL.
export const demos: Demo[] = [
  { name: 'default', params: {} }, // 档案：有待确认时停在投票卡
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：6 条，无待确认，停在全部
  { name: 'empty', params: { state: 'empty' } }, // 空
  { name: 'paused', params: { demo: 'paused' } }, // 已暂停
  { name: 'loading', params: { state: 'loading' } }, // 加载中
  { name: 'error', params: { state: 'error' } }, // 读取失败
  { name: 'light', params: { theme: 'light' } }, // 亮色
  { name: 'detail', params: { sel: v31Id('g2') } }, // 选中一条：右栏详情，窄窗是抽屉
  { name: 'filter', params: { src: 'observed' } }, // 记忆管线按来源跳来：搜「观察所得」
  { name: 'search', params: { q: '周报' } }, // 搜索
  { name: 'projects', params: { view: 'projects' } }, // 项目：工作记忆的任务
  { name: 'review', params: { view: 'activity' } }, // 回顾：工作片段和原始观察
  { name: 'absent', params: { demo: 'absent', view: 'projects' } }, // agentd 没有 /memory/tasks：没有「项目」页签
];
