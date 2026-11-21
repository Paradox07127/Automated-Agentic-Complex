import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'light', params: { theme: 'light' } }, // 亮色
  { name: 'loading', params: { state: 'loading' } }, // 加载中
  { name: 'error', params: { state: 'error' } }, // 读不到记忆和诊断状态
  { name: 'empty', params: { state: 'empty' } }, // 还没有记忆和整理记录
  { name: 'run', params: { run: 'mrun-00' } }, // 打开一条记忆生成记录
];
