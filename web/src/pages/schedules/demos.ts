import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'light', params: { theme: 'light' } },
  { name: 'empty', params: { state: 'empty' } },
  { name: 'loading', params: { state: 'loading' } },
  { name: 'error', params: { state: 'error' } },
];
