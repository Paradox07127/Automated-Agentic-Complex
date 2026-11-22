import { useEffect } from 'react';
import type { AnyRouter } from '@tanstack/react-router';
import type { BriefTab } from '../pages/overview/briefTabs';

/**
 * Where a jump lands: page, then the page's own selection / tab, then `focus`, the landing's `data-nav-target`
 * that the shell scrolls to and highlights. Without `focus` the landing is derived (selected task, settings row,
 * else the page header).
 */
export type NavTarget =
  | {
      page: 'overview';
      tab?: BriefTab;
      /** Task, `job:` or session id opens its detail; a pending item id flashes its decision row. */
      sel?: string;
      open?: string;
      create?: 'role' | 'code' | 'goal';
      /** Episode id, `id@YYYY-MM-DD` for another day. */
      ep?: string;
      day?: string;
      focus?: string;
    }
  | { page: 'chat'; conv?: string; turn?: string; focus?: string }
  | {
      page: 'memory';
      view?: 'projects' | 'about';
      ep?: string;
      /** Fact id; opens 用户档案 (`view: 'about'`). */
      sel?: string;
      /** Source filter of 用户档案: agentd's source name or its short key. */
      src?: string;
      focus?: string;
    }
  | { page: 'pipeline'; run?: string; focus?: string }
  | { page: 'character'; tab?: 'profile' | 'motion' | 'behavior' | 'render' | 'scene'; view?: 'photo' | 'mmd'; pane?: 'motion' | 'chain' | 'look' | 'import'; row?: string; focus?: string }
  | {
      page: 'diag';
      tab?: 'run' | 'timeline' | 'records' | 'logs';
      /** Turn id on the timeline. */
      sel?: string;
      run?: string;
      /** Record kind on the records tab. */
      kind?: string;
      memory?: string;
      /** Process row, `state` (internal state) or `usage` (token and cost card). */
      item?: string;
      focus?: string;
    }
  | { page: 'settings'; group?: string; item?: string; focus?: string }
  | { page: 'trace'; turn?: string; focus?: string }
  | { page: 'schedules' | 'tune'; focus?: string }
  | { page: 'ds' | 'dv'; focus?: string };

export type PageId = NavTarget['page'];

export type Go = (target: NavTarget) => void;

/** View flags a jump keeps, so a light-theme or still screenshot session stays in that mode. */
const CARRY = ['theme', 'still'];

let router: AnyRouter | null = null;

/** Called once by the app router; tests without a router fall back to the hash. */
export function setNavRouter(r: AnyRouter): void {
  router = r;
}

function landing(t: NavTarget): string {
  if (t.focus) return t.focus;
  if (t.page === 'overview' && t.sel) return `task-${t.sel}`;
  if (t.page === 'settings' && t.item) return `set-${t.item}`;
  if (t.page === 'diag' && t.item === 'usage') return 'diag-usage';
  if (t.page === 'diag' && t.item && t.item !== 'state') return `proc-${t.item}`;
  return 'page';
}

function currentQuery(): URLSearchParams {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
}

/** Hash route of a target, e.g. `/overview?sel=t1&focus=task-t1`, carrying `theme`/`still`; the desktop stack hands it to `openMain`. */
export function navRoute(t: NavTarget): string {
  const { page, focus: _focus, ...rest } = t;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) if (v != null) q.set(k, String(v));
  q.set('focus', landing(t));
  const cur = currentQuery();
  for (const k of CARRY) {
    const v = cur.get(k);
    if (v != null && !q.has(k)) q.set(k, v);
  }
  return `/${page}?${q.toString()}`;
}

/** The one navigation function inside the main window. */
export const navigate: Go = (target) => {
  const route = navRoute(target);
  if (router) void router.history.push(route);
  else window.location.hash = `#${route}`;
};

export function useGo(): Go {
  return navigate;
}

/** How long the landing frame stays before it fades; `still` keeps it for screenshots. */
const HIGHLIGHT_MS = 1200;

/**
 * Landing highlight: after a jump, scroll the `[data-nav-target]` element into view and mark it with
 * `data-nav-hl` (yellow frame fading out). Targets that render later (async data) are awaited.
 */
export function useLandingFocus(focus: string | null, search: string, still: boolean): void {
  useEffect(() => {
    if (!focus) return;
    const selector = `[data-nav-target="${CSS.escape(focus)}"]`;
    let el: HTMLElement | null = null;
    let fade = 0;
    const clear = () => el?.removeAttribute('data-nav-hl');
    const mark = (): boolean => {
      el = document.querySelector<HTMLElement>(selector);
      if (!el) return false;
      el.setAttribute('data-nav-hl', '');
      el.scrollIntoView({ block: 'nearest' });
      if (!still) fade = window.setTimeout(clear, HIGHLIGHT_MS);
      return true;
    };
    const observer = new MutationObserver(() => {
      if (mark()) observer.disconnect();
    });
    if (!mark()) observer.observe(document.body, { childList: true, subtree: true });
    const giveUp = window.setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      window.clearTimeout(giveUp);
      window.clearTimeout(fade);
      clear();
    };
  }, [focus, search, still]);
}
