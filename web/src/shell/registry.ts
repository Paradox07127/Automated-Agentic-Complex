import { useMemo } from 'react';
import { useDevMode } from './devMode';
import type { PluginId, PluginState } from './plugins';
import type { Demo, PageRoute } from './types';

// Pages register themselves: adding src/pages/<id>/route.ts is enough, no shared file to edit.
const pages = import.meta.glob<{ route: PageRoute }>('../pages/*/route.ts', { eager: true });
// URL presets of the pages; the shipped app (`vite build --mode app`) has none: MODE is replaced at build time so the branch is removed.
const presets = import.meta.env.MODE !== 'app' ? import.meta.glob<{ demos: Demo[] }>('../pages/*/demos.ts', { eager: true }) : {};

export const pageRoutes: Array<PageRoute & { demos: Demo[] }> = Object.values(pages)
  .map((m) => ({ ...m.route, demos: presets[`../pages/${m.route.id}/demos.ts`]?.demos ?? [] }))
  .sort((a, b) => a.order - b.order);

export function findRoute(pathname: string): PageRoute | undefined {
  return pageRoutes.find((r) => r.path === pathname);
}

/** The pages the menus, ⌘K and the hotkeys offer: every page, devOnly pages only in 开发者模式; a page whose plug-in is off is listed and opens 已关闭. */
export function visibleRoutes(devMode: boolean): Array<PageRoute & { demos: Demo[] }> {
  return pageRoutes.filter((r) => !r.devOnly || devMode);
}

/** The name of a plug-in's switch in 设置, for the 已关闭 reasons. */
export const SWITCH_NAME: Record<PluginId, string> = {
  light_ai: 'AI 对话',
  screen_awareness: '屏幕感知',
  screen_reading: '屏幕识读',
  daily_brief: '每日简报',
  coding_sessions: '编码会话',
  personal_agent: '派发任务和定时任务',
  harness_bridge: '改用 Codex、Claude Code 或 ACP',
  computer_use: '操作电脑',
  external_access: '外部智能体接入',
  motion_generation: '生成新动作',
};

/** Why an entry is 已关闭 while its plug-in is off. */
export const offReason = (id: PluginId) => `已关闭：设置里关着「${SWITCH_NAME[id]}」`;

/** The reason a page's menu entry carries while its plug-in is off. */
export function routeOff(r: PageRoute, plugins: PluginState): string | undefined {
  return r.plugin && !plugins[r.plugin] ? offReason(r.plugin) : undefined;
}

export function useVisibleRoutes(): Array<PageRoute & { demos: Demo[] }> {
  const devMode = useDevMode();
  return useMemo(() => visibleRoutes(devMode), [devMode]);
}
