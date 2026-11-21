import { useEffect } from 'react';

export type ThemeName = 'dark' | 'light';

/** A native appearance event source: calls back on every change, returns its unsubscribe. */
export type AppearanceFeed = (cb: (theme: ThemeName) => void) => () => void;

const SYSTEM_LIGHT = '(prefers-color-scheme: light)';

/** Sets data-theme before the first render; without it a light system paints one frame of the dark :root tokens. */
export function applyInitialTheme() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? location.search);
  const param = q.get('theme') ?? new URLSearchParams(location.search).get('theme');
  document.documentElement.dataset.theme = param === 'light' || param === 'dark' ? param : window.matchMedia(SYSTEM_LIGHT).matches ? 'light' : 'dark';
}

/**
 * `<html data-theme>` for main and stack: URL `theme=light|dark` wins (screenshots), else the system appearance,
 * followed while open. `native` is for a bridge appearance event once protocol.ts has one; its pushes override the media query.
 */
export function useSystemTheme(param: string | null, native?: AppearanceFeed) {
  useEffect(() => {
    const set = (t: ThemeName) => {
      document.documentElement.dataset.theme = t;
    };
    if (param === 'light' || param === 'dark') {
      set(param);
      return;
    }
    const mq = window.matchMedia(SYSTEM_LIGHT);
    const follow = () => set(mq.matches ? 'light' : 'dark');
    follow();
    mq.addEventListener('change', follow);
    const off = native?.(set);
    return () => {
      mq.removeEventListener('change', follow);
      off?.();
    };
  }, [param, native]);
}
