import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} }, // 第 1 步：选角色
  { name: 'step2', params: { demo: 'step2' } }, // 第 2 步：怎么陪你
  { name: 'step3', params: { demo: 'step3' } }, // 完成：角色已就位
  { name: 'light', params: { theme: 'light' } },
  { name: 'step2-light', params: { demo: 'step2', theme: 'light' } },
  { name: 'step3-light', params: { demo: 'step3', theme: 'light' } },
  { name: 'loading', params: { state: 'loading' } },
  { name: 'error', params: { state: 'error' } },
];
