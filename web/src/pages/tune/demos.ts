import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right; `full` draws what agentd and the host do not send yet.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'full', params: { demo: 'full' } }, // 含真实接口还没有的区块：屏幕示意、状态倍数、今日播放（只在假桥下）
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据少：状态 13:20 起记录，播放很少
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 读取失败
  { name: 'beat', params: { ptab: 'beat' } }, // 行为决策页签
  { name: 'offline', params: { demo: 'offline' } }, // 角色未运行：行为与画面只读
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 后台断开：曲线灰掉标上次时间
  { name: 'state-none', params: { demo: 'state-none' } }, // 状态还没开始记录
  { name: 'render-suspended', params: { demo: 'suspended' } }, // 画面暂停中：宿主不发读数
];
