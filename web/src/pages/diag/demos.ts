import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据稀疏：今天 9 轮，近 1 小时 3 轮
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 后台断开：读不到诊断状态
  { name: 'replay', params: { sel: 'tr3' } }, // 回放一轮：流程图点亮它走过的节点，下方是轮次详情
  { name: 'full', params: { demo: 'full' } }, // 后端还没有的区块：阶段 p50、进程 CPU 和内存历史、在线时段
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 读到过数据后断开：标「后台已断开」和数据时刻
  { name: 'paused', params: { demo: 'paused' } }, // 暂停刷新
  { name: 'state', params: { item: 'state' } }, // 展开内部状态
  { name: 'obs', params: { item: 'state', obs: 'a2a2a2a2a2a2' } }, // 内部状态里展开一条观察详情
  { name: 'confirm', params: { demo: 'confirm' } }, // 全部重启确认
  { name: '7d', params: { rng: '7d' } }, // 轮次时间轴 7 天
  { name: 'empty', params: { state: 'empty' } }, // 最近 24 h 没有轮次
];
