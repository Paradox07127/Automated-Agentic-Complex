import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'schedules',
  path: '/schedules',
  title: '定时任务',
  en: 'Schedules',
  order: 95,
  group: 'secondary',
  nav: false,
  component: lazyRouteComponent(() => import('./Page'), 'SchedulesPage'),
};
