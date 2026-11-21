import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'diag',
  path: '/diag',
  title: '诊断',
  en: 'Diagnostics',
  order: 110,
  group: 'secondary',
  devOnly: true,
  component: lazyRouteComponent(() => import('./Page'), 'DiagPage'),
};
