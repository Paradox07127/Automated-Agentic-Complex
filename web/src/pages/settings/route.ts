import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'settings',
  path: '/settings',
  title: '设置',
  icon: 'settings',
  en: 'Settings',
  order: 80,
  group: 'secondary',
  hotkey: '⌘,',
  component: lazyRouteComponent(() => import('./Page'), 'SettingsPage'),
};
