// The first-run guide in its own window:
// `main.html#/onboarding` on the `onboarding` surface, opened at launch while config.json has no `"onboarding_done": true`
// and from `app.action('open_onboarding')`. 「完成」 closes it and opens the main window at the destination; the close button
// only closes it, so it opens again next launch.
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron';
import type { Handler } from '../../common/bridge.ts';
import { PageSession } from '../../common/page.ts';
import { ORIGIN } from '../../common/ui.ts';
import { readObject } from '../ops/settings.ts';
import { guardWebContents, type WebGuardPorts } from '../web-guard.ts';

export type OnboardingDestination = 'home' | 'model' | 'plugins';

/** The routes the guide's end opens. */
export const DESTINATIONS: Record<OnboardingDestination, string> = {
  home: '/home', model: '/settings?group=model', plugins: '/settings?group=plugins',
};

/** The room a title bar and the window's borders take on either system. */
const FRAME = 48;

/** Titled, resizable, closable and miniaturizable; 1080×760 or less, so the window with its frame fits `area` (a work area), and
 *  the page scrolls what does not fit. */
export function windowOptions(area: { width: number; height: number }): BrowserWindowConstructorOptions {
  const minWidth = 900, minHeight = 560;
  return {
    width: Math.max(minWidth, Math.min(1080, area.width - FRAME)), height: Math.max(minHeight, Math.min(760, area.height - FRAME)),
    useContentSize: true, title: '首次启动引导', resizable: true, minWidth, minHeight, maximizable: false, fullscreenable: false,
    minimizable: true, closable: true, show: false,
  };
}

export interface OnboardingWindowOptions {
  /** config.json, whose `onboarding_done` says the guide was finished. */
  configPath: string;
  /** Makes a hidden window with `options` and the bridge's preload. */
  makeWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  /** false when the web UI is not built. */
  served(): boolean;
  /** The work area of the display the guide opens on. */
  workArea(): { width: number; height: number };
  /** A new guide from step 1: the onboarding surface's ops; null when config.json did not load. */
  ops(): ReadonlyMap<string, Handler<PageSession>> | null;
  /** Gives the window's page its bridge. */
  register(contents: WebContents, page: PageSession, ops: ReadonlyMap<string, Handler<PageSession>>): void;
  unregister(id: number): void;
  /** Opens the main window at hash route `route`. */
  openMain(route: string): void;
  /** false on a test instance, whose windows must not take the focus from the user's app. */
  activate: boolean;
  /** The main window's page guards; absent leaves the page unguarded. */
  guard?: WebGuardPorts;
  log(line: string): void;
}

export interface OnboardingWindow {
  /** Config.json has no `"onboarding_done": true`. */
  firstRun(): boolean;
  /** At launch on a first run, or from 设置 › 关于; an open guide, minimized too, only comes to the front. */
  begin(): void;
  /** Closes the guide and opens the main window at `destination`. */
  end(destination: OnboardingDestination): void;
}

export function onboardingWindow(o: OnboardingWindowOptions): OnboardingWindow {
  let win: BrowserWindow | null = null;
  const front = (w: BrowserWindow) => (o.activate ? w.show() : w.showInactive());
  return {
    firstRun: () => readObject(o.configPath).onboarding_done !== true,
    begin: () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        front(win);
        return;
      }
      if (!o.served()) return o.log('onboarding: no built web UI');
      const ops = o.ops();
      if (!ops) return o.log('onboarding: no guide (config failed)');
      const w = o.makeWindow(windowOptions(o.workArea()));
      const contents = w.webContents, id = contents.id;
      const page = new PageSession((sub, stream, kind, payload) => {
        if (!contents.isDestroyed()) contents.send('bridge:push', sub, stream, kind, payload);
      });
      o.register(contents, page, ops);
      if (o.guard) guardWebContents(contents, 'main', o.guard);
      // Subscriptions end with the document that made them.
      contents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) page.end(); });
      contents.on('render-process-gone', () => page.end());
      // The window keeps its own title; the page's <title> does not replace it.
      w.on('page-title-updated', (e) => e.preventDefault());
      w.on('closed', () => {
        page.end();
        o.unregister(id);
        win = null;
      });
      w.once('ready-to-show', () => front(w));
      void w.loadURL(`${ORIGIN}/main.html#/onboarding`);
      w.center();
      win = w;
      o.log('ONBOARDING shown');
    },
    end: (destination) => {
      win?.close();
      o.openMain(DESTINATIONS[destination]);
    },
  };
}
