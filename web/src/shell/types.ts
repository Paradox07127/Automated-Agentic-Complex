import type { RouteComponent } from '@tanstack/react-router';
import type { PluginId } from '../bridge/plugins.generated';
import type { IconName } from '../ui/Icon';

/** A screenshot-able state of a page: name plus the hash query that opens it. */
export interface Demo {
  name: string;
  params: Record<string, string>;
}

/** What every `src/pages/<id>/route.ts` exports as `route`. */
export interface PageRoute {
  /** Equals the directory name. */
  id: string;
  /** `/<id>`. */
  path: `/${string}`;
  title: string;
  /** Drawn before the title in the page menu, ⌘K and 主页's keys. */
  icon?: IconName;
  /** English name; ⌘K search matches it, nothing on screen shows it. */
  en: string;
  /** Sidebar position, ascending. */
  order: number;
  group: 'primary' | 'secondary';
  hotkey?: string;
  /** false: reachable by URL only, kept out of the sidebar and ⌘K (the native onboarding window). */
  nav?: false;
  /** Listed in the sidebar and ⌘K only in 开发者模式; its URL and hotkey still open it. */
  devOnly?: true;
  /** The plug-in it belongs to: kept out of the menus, ⌘K and the hotkeys while that plug-in is off; its URL still opens it. */
  plugin?: PluginId;
  /** Lazy for the pages (`lazyRouteComponent`), so each page's code loads on first visit. */
  component: RouteComponent;
}
