import type { Demo } from '../../shell/types';

// Every state below must open by URL and look right.
export const demos: Demo[] = [
  { name: 'default', params: {} }, // 选中整理
  { name: 'light', params: { theme: 'light' } }, // 亮色
  { name: 'obs', params: { station: 'obs' } }, // 观察：额度和最近请求
  { name: 'interp', params: { station: 'interp' } }, // 理解：她现在的理解和最近理解
  { name: 'store', params: { station: 'store' } }, // 记忆库：按来源和 14 天新增
  { name: 'loading', params: { state: 'loading' } }, // 加载中
  { name: 'error', params: { state: 'error' } }, // 后台断开
  { name: 'empty', params: { state: 'empty' } }, // 还没有数据
  { name: 'run', params: { run: 'mrun-00' } }, // 打开一批的生成记录
];
