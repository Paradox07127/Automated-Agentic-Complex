import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'tune',
  path: '/tune',
  title: '调参',
  en: 'Tune',
  order: 140,
  group: 'secondary',
  devOnly: true,
  component: lazyRouteComponent(() => import('./Page'), 'TunePage'),
};
