import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'home',
  path: '/home',
  title: '主页',
  icon: 'grid',
  en: 'Home',
  order: 5,
  group: 'primary',
  hotkey: '⌘0',
  component: lazyRouteComponent(() => import('./Page'), 'HomePage'),
};
