import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { MODAL_ROOT_ID } from '../ui';
import { CmdPalette } from './CmdPalette';
import { CommandBar } from './CommandBar';
import { COMPUTER_USE_DEMO, ComputerUseBanner } from './ComputerUseBanner';
import { useDemo } from './demo';
import { HeaderSlotContext } from './headerSlot';
import { navigate, useLandingFocus, type PageId } from './nav';
import { PageExit } from './pageExit';
import { getBridge } from '../bridge';
import { getPlugins, loadPlugins } from './plugins';
import { findRoute, useVisibleRoutes } from './registry';
import { ToastHost } from './toast';
import { useSystemTheme } from './useSystemTheme';
import styles from './Layout.module.css';

/** Window event a page dispatches to open the ⌘K palette. */
export const OPEN_PALETTE = 'endfield:open-palette';

export function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const focus = new URLSearchParams(searchStr).get('focus');
  const route = findRoute(pathname);
  const guide = route?.id === 'onboarding';
  const { theme, still, demo } = useDemo();
  const [palette, setPalette] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null);
  const [right, setRight] = useState<HTMLDivElement | null>(null);
  const [action, setAction] = useState<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const slot = useMemo(() => ({ setSub, tabs, right, action, bottom }), [tabs, right, action, bottom]);
  const routes = useVisibleRoutes();
  const shown = useRef(routes);
  shown.current = routes;

  // Plug-in switches from config.json, read again whenever the shell changes saved values.
  useEffect(() => {
    const bridge = getBridge();
    void loadPlugins(bridge);
    return bridge.settings.onChange(() => void loadPlugins(bridge));
  }, []);

  // Key hints (html[data-keys]) show only while ⌘ or Ctrl is held.
  useEffect(() => {
    const set = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) document.documentElement.dataset.keys = '';
      else delete document.documentElement.dataset.keys;
    };
    const clear = () => delete document.documentElement.dataset.keys;
    window.addEventListener('keydown', set);
    window.addEventListener('keyup', set);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', set);
      window.removeEventListener('keyup', set);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useLandingFocus(guide ? null : focus, `${pathname}?${searchStr}`, still);
  useSystemTheme(theme);
  // Reduce Motion and Reduce Transparency come from the tokens' media queries; window.onA11y is the stack surface's only.

  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  useEffect(() => setPalette(demo === 'palette'), [demo]);

  useEffect(() => {
    if (guide) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      // ⌘N 派发任务 from any page; the tasks page handles it first, and an open dialog or sheet keeps it.
      if (e.key.toLowerCase() === 'n') {
        if (e.defaultPrevented || !getPlugins().personal_agent || !getPlugins().daily_brief) return;
        e.preventDefault();
        if (document.querySelector('[aria-modal="true"]')) return;
        setPalette(false);
        navigate({ page: 'overview', create: 'role', focus: 'task-create' });
        return;
      }
      // ⌘1–7 and ⌘, from each route's `hotkey`; a shell that reports `hotkeys` owns them in its menu.
      if (window.agenticComplex?.capabilities.hotkeys) return;
      const target = shown.current.find((r) => r.hotkey === `⌘${e.key}`);
      if (!target) return;
      e.preventDefault();
      setPalette(false);
      navigate({ page: target.id as PageId });
    };
    const onOpen = () => setPalette(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE, onOpen);
    };
  }, [guide]);

  if (guide) return <><main className={styles.guide} data-route-id="onboarding"><Outlet /></main><ToastHost /></>;

  return (
    <HeaderSlotContext.Provider value={slot}>
      <div className={styles.window} data-bare={route?.id === 'home' || undefined}>
        {route?.id === 'home' && <div className={styles.drag} aria-hidden="true" />}
        {route?.id !== 'home' && <CommandBar routes={routes} activeId={route?.id} title={route?.title ?? ''} sub={sub} tabsRef={setTabs} rightRef={setRight} actionRef={setAction} />}
        {route?.id !== 'home' && <div className={styles.tri} data-shell="tri" aria-hidden="true" />}
        <div className={styles.shell}>
          <main className={styles.main} data-route-id={route?.id ?? 'not-found'}>
            <ComputerUseBanner {...(demo === 'computer-use' ? { demo: COMPUTER_USE_DEMO } : {})} />
            <div ref={content} className={styles.content} data-shell="content">
              <PageExit host={content} id={route?.id ?? 'not-found'}>
                <Outlet />
              </PageExit>
            </div>
            <div ref={setBottom} className={styles.bottomBar} data-shell="bottom-bar" data-slot="bottom" data-theme="dark" />
          </main>
          {palette && <CmdPalette routes={routes} onClose={() => setPalette(false)} />}
        </div>
      </div>
      <div id={MODAL_ROOT_ID} className={styles.modalRoot} />
      <ToastHost />
    </HeaderSlotContext.Provider>
  );
}
