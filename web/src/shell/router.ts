import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { getBridge } from '../bridge';
import { ErrorPage, reportPageException } from './ErrorPage';
import { Layout } from './Layout';
import { setNavRouter } from './nav';
import { NotFound } from './Placeholder';
import { pageRoutes } from './registry';

export function createAppRouter() {
  const root = createRootRoute({ component: Layout, notFoundComponent: NotFound });
  const home = pageRoutes[0]?.path ?? '/';
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: () => {
      throw redirect({ to: home });
    },
  });
  // MMD is a section of 角色: old links land there with the view flags.
  const mmd = createRoute({
    getParentRoute: () => root,
    path: '/mmd',
    beforeLoad: ({ search }) => {
      const flags = Object.fromEntries(Object.entries(search as Record<string, unknown>).filter(([k]) => k === 'theme' || k === 'still'));
      throw redirect({ to: '/character', search: { view: 'mmd', ...flags }, replace: true });
    },
  });
  const pages = pageRoutes.map((r) =>
    createRoute({
      getParentRoute: () => root,
      path: r.path,
      component: r.component,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren([index, mmd, ...pages]),
    history: createHashHistory(),
    defaultErrorComponent: ErrorPage,
    // The hash is the route.
    defaultOnCatch: (error, info) => reportPageException(error, info.componentStack, window.location.hash.slice(1)),
  });
  setNavRouter(router);
  // The native main window sends later entry points here; the first one arrives as the URL fragment.
  getBridge().window.onRoute((route) => void router.history.push(route));
  return router;
}
