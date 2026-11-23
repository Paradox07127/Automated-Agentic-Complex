import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'tasks',
  path: '/tasks',
  title: '任务',
  icon: 'clock',
  en: 'Tasks',
  order: 95,
  group: 'secondary',
  nav: false,
  plugin: 'personal_agent',
  component: lazyRouteComponent(() => import('./Page'), 'TasksPage'),
};
