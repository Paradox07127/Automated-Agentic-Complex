import { lazyRouteComponent } from '@tanstack/react-router';
import type { PageRoute } from '../../shell/types';

// The native guide window opens main.html#/onboarding on its own `onboarding` bridge surface.
export const route: PageRoute = {
  id: 'onboarding',
  path: '/onboarding',
  title: '首次设置',
  icon: 'star',
  en: 'Onboarding',
  order: 90,
  group: 'secondary',
  nav: false,
  component: lazyRouteComponent(() => import('./Page'), 'OnboardingPage'),
};
