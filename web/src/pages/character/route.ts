import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'character',
  path: '/character',
  title: '角色',
  en: 'Character',
  order: 60,
  group: 'secondary',
  hotkey: '⌘4',
  component: lazyRouteComponent(() => import('./Page'), 'CharacterPage'),
};
