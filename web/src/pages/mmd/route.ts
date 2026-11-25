import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'mmd',
  path: '/mmd',
  title: 'MMD',
  icon: 'file',
  en: 'MMD',
  order: 65,
  group: 'secondary',
  component: lazyRouteComponent(() => import('./Page'), 'MmdPage'),
};
