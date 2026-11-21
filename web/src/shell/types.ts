import type { RouteComponent } from '@tanstack/react-router';

/** A screenshot-able state of a page: name plus the hash query that opens it. */
export interface Demo {
  name: string;
  params: Record<string, string>;
}

/** What every `src/pages/<id>/route.ts` (and `src/dev/<id>/route.ts`) exports as `route`. */
export interface PageRoute {
  /** Equals the directory name. */
  id: string;
  /** `/<id>`. */
  path: `/${string}`;
  title: string;
  /** English name; ⌘K search matches it, nothing on screen shows it. */
  en: string;
  /** Sidebar position, ascending. */
  order: number;
  group: 'primary' | 'secondary' | 'dev';
  hotkey?: string;
  /** false: reachable by URL only, kept out of the sidebar and ⌘K (the native onboarding window). */
  nav?: false;
  /** Listed in the sidebar and ⌘K only in 开发者模式; its URL and hotkey still open it. */
  devOnly?: true;
  /** Lazy for the pages (`lazyRouteComponent`), so each page's code loads on first visit. */
  component: RouteComponent;
  /** Pages leave this out: the registry attaches `src/pages/<id>/demos.ts` outside the shipped app. */
  demos?: Demo[];
}
