import type { Demo } from '../../shell/types';

export const demos: Demo[] = [
  { name: 'default', params: {} },
  { name: 'light', params: { theme: 'light' } },
  { name: 'sched', params: { tab: 'sched' } },
  { name: 'done', params: { tab: 'done' } },
  { name: 'dispatch', params: { create: 'role' } },
  { name: 'new-schedule', params: { tab: 'sched', create: 'sched' } },
  { name: 'empty', params: { state: 'empty' } },
  { name: 'loading', params: { state: 'loading' } },
  { name: 'error', params: { state: 'error' } },
];
