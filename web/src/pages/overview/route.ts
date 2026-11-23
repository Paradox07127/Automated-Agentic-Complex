import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'overview',
  path: '/overview',
  title: '每日简报',
  icon: 'sun',
  en: 'Briefing',
  order: 10,
  group: 'primary',
  hotkey: '⌘1',
  plugin: 'daily_brief',
  component: lazyRouteComponent(() => import('./Gate'), 'OverviewGate'),
};
