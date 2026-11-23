import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'memory',
  path: '/memory',
  title: '记忆',
  icon: 'data',
  en: 'Memory',
  order: 30,
  group: 'primary',
  hotkey: '⌘3',
  component: lazyRouteComponent(() => import('./Page'), 'MemoryPage'),
};
