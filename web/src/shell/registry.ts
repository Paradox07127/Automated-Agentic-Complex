import { useMemo } from 'react';
import { useDevMode } from './devMode';
import { usePlugins, type PluginState } from './plugins';
import type { Demo, PageRoute } from './types';

// Pages register themselves: adding src/pages/<id>/route.ts is enough, no shared file to edit.
const pages = import.meta.glob<{ route: PageRoute }>('../pages/*/route.ts', { eager: true });
// `vite build --mode app` (the shipped app) drops the dev pages; MODE is replaced at build time so the branch is removed.
const dev = import.meta.env.MODE !== 'app' ? import.meta.glob<{ route: PageRoute }>('../dev/*/route.ts', { eager: true }) : {};
// URL presets of the pages; the shipped app has none.
const presets = import.meta.env.MODE !== 'app' ? import.meta.glob<{ demos: Demo[] }>('../pages/*/demos.ts', { eager: true }) : {};

export const pageRoutes: Array<PageRoute & { demos: Demo[] }> = [...Object.values(pages), ...Object.values(dev)]
  .map((m) => ({ ...m.route, demos: m.route.demos ?? presets[`../pages/${m.route.id}/demos.ts`]?.demos ?? [] }))
  .sort((a, b) => a.order - b.order);

export function findRoute(pathname: string): PageRoute | undefined {
  return pageRoutes.find((r) => r.path === pathname);
}

/** The pages the menus, ⌘K and the hotkeys offer: a plug-in's pages while it is on, devOnly pages in 开发者模式. */
export function visibleRoutes(plugins: PluginState, devMode: boolean): Array<PageRoute & { demos: Demo[] }> {
  return pageRoutes.filter((r) => (!r.plugin || plugins[r.plugin]) && (!r.devOnly || devMode));
}

export function useVisibleRoutes(): Array<PageRoute & { demos: Demo[] }> {
  const plugins = usePlugins();
  const devMode = useDevMode();
  return useMemo(() => visibleRoutes(plugins, devMode), [plugins, devMode]);
}
