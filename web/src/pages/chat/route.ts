import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

export const route: PageRoute = {
  id: 'chat',
  path: '/chat',
  title: '对话',
  icon: 'send',
  en: 'Chat',
  order: 20,
  group: 'primary',
  hotkey: '⌘2',
  component: lazyRouteComponent(() => import('./Gate'), 'ChatGate'),
};
