import type { Demo } from '../../shell/types';
import { v31Id } from '../../mock/fixtures/ids';

// Demo list: every state below must open by URL; the 用户档案 ones match prototype-v3 memory (its 正常 / 数据少 / 空 / 已暂停 / 加载中 demos and ?sheet=1).
export const demos: Demo[] = [
  { name: 'default', params: {} }, // 项目：工作记忆的任务卡
  { name: 'about', params: { view: 'about' } }, // 用户档案
  { name: 'sparse', params: { demo: 'sparse', view: 'about' } }, // 数据少：6 条，无待确认
  { name: 'empty', params: { state: 'empty' } }, // 空
  { name: 'paused', params: { demo: 'paused', view: 'about' } }, // 已暂停
  { name: 'loading', params: { state: 'loading' } }, // 加载中
  { name: 'error', params: { state: 'error', view: 'about' } }, // 读取失败
  { name: 'light', params: { theme: 'light' } }, // 亮色
  { name: 'full', params: { demo: 'full', view: 'about' } }, // 版本历史、已锁定、不再提及、停止此类推断
  { name: 'sheet', params: { sel: v31Id('a3') } }, // 抽屉：出处、引用记录
  { name: 'filter', params: { src: 'observed' } }, // 只看「观察」
  { name: 'search', params: { q: '周报', view: 'about' } }, // ⌘F 搜索
  { name: 'search-projects', params: { q: 'HostLink' } }, // 同一个搜索过滤项目
  { name: 'absent', params: { demo: 'absent' } }, // agentd 没有 /memory/tasks：只有「用户档案」
];
