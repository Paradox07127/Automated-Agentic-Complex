import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'sparse', params: { demo: 'sparse' } }, // 数据稀疏：今天 9 轮，近 1 小时 3 轮
  { name: 'light', params: { theme: 'light' } }, // 亮色主题
  { name: 'loading', params: { state: 'loading' } }, // 加载
  { name: 'error', params: { state: 'error' } }, // 后台断开：读不到诊断状态
  { name: 'proc', params: { tab: 'proc', demo: 'full' } }, // 进程页签：每个进程一行曲线
  { name: 'render', params: { tab: 'render' } }, // 渲染页签：帧率和帧耗时
  { name: 'flow', params: { tab: 'flow', demo: 'full' } }, // 管道页签：轮次管道、近 24 小时、模型调用
  { name: 'full', params: { demo: 'full' } }, // 后端还没有的区块：阶段 p50、进程 CPU 和内存历史、在线时段
  { name: 'disconnected', params: { demo: 'disconnected' } }, // 读到过数据后断开：标「后台已断开」和数据时刻
  { name: 'paused', params: { demo: 'paused' } }, // 暂停刷新
  { name: 'state', params: { tab: 'state' } }, // 状态页签：当前轮、主动发言闸门、现在
  { name: 'confirm', params: { demo: 'confirm' } }, // 全部重启确认
  { name: 'empty', params: { state: 'empty' } }, // 最近 24 h 没有轮次
];
