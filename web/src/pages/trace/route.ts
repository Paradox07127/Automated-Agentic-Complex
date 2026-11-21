import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'trace',
  path: '/trace',
  title: '运行记录',
  en: 'Trace',
  order: 120,
  group: 'secondary',
  component: lazyRouteComponent(() => import('./Page'), 'TracePage'),
};
