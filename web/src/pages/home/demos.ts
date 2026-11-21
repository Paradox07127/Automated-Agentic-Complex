import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'light', params: { theme: 'light' } },
  { name: 'loading', params: { state: 'loading' } },
  { name: 'empty', params: { state: 'empty' } }, // 没有待处理和进行中的事
  { name: 'error', params: { state: 'error' } }, // 刷新失败：保留上次数据
  { name: 'still', params: { still: '1' } }, // 不播展开动画，时钟停住
  { name: 'palette', params: { demo: 'palette' } }, // 从主页打开的 ⌘K 面板
];
