import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'pipeline',
  path: '/pipeline',
  title: '记忆管线',
  en: 'Memory Pipeline',
  order: 130,
  group: 'secondary',
  devOnly: true,
  component: lazyRouteComponent(() => import('./Page'), 'PipelinePage'),
};
