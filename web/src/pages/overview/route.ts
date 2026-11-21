import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'overview',
  path: '/overview',
  title: '工业简报',
  en: 'Briefing',
  order: 10,
  group: 'primary',
  hotkey: '⌘1',
  component: lazyRouteComponent(() => import('./Page'), 'OverviewPage'),
};
