// The shell draws the live preview into the page's preview layer, under the page's UI and over the room; without a layer, over
// the stage on top of everything, so anything the page draws over the stage has to make it hide.
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { getBridge, type PreviewPlacement } from '../../bridge';
import { MODAL_ROOT_ID } from '../../ui';

/** The page's full-size layer the shell draws the preview into (src/preload/index.ts in the shell). */
export const PREVIEW_LAYER = '[data-preview-layer]';

let lookRevision = 0;
const lookListeners = new Set<() => void>();

/** Her look changed where the stage's props do not say (a mod switch was accepted): a shown preview shows again, and the shell
 *  reads her look anew. */
export function previewLookChanged(): void {
  lookRevision += 1;
  for (const listener of lookListeners) listener();
}

/** The character page's saved settings (settings.tsx useCharSettings), keyed by row id; the preview draws with the 画面 ones
 *  and her physics switch. */
const SETTINGS_KEY = ['character', 'settings'];
const renderSettings = (data: unknown) => {
  const saved = (data as { saved?: Record<string, unknown> } | undefined)?.saved ?? {};
  return JSON.stringify(Object.keys(saved).filter((k) => k.startsWith('rnd.') || k === 'beh.physics').sort().map((k) => [k, saved[k]]));
};

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether the page draws something over `stage`: a dialog or sheet in the modal root, any dialog (the command palette
 * included), or a menu, dropdown list or toast that overlaps the stage. Never with a preview layer: the page's UI stands over her.
 */
export function previewCovered(stage: Element): boolean {
  if (document.querySelector(PREVIEW_LAYER)) return false;
  if ((document.getElementById(MODAL_ROOT_ID)?.childElementCount ?? 0) > 0) return true;
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return true;
  const r = stage.getBoundingClientRect();
  return Array.from(document.querySelectorAll('[role="menu"], [role="listbox"][data-overlay], [data-stub="Toast"]')).some((el) => overlaps(r, el.getBoundingClientRect()));
}

/** Whether something the page draws covers `stage`; checked again on each DOM change, once per frame. */
export function usePreviewOverlay(stage: HTMLElement | null): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (!stage) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setCovered(previewCovered(stage));
    };
    check();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(check);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [stage]);
  return covered;
}

/** Whether a scrolling box or the window cuts off part of `r`, the rect of `el`; the native view would spill past it. */
function clipped(el: Element, r: DOMRect): boolean {
  if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) return true;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    // A display: contents box has no rect of its own (0×0) and clips nothing, whatever its overflow says.
    if (s.display === 'contents' || (s.overflowX === 'visible' && s.overflowY === 'visible')) continue;
    const c = p.getBoundingClientRect();
    if (r.left < c.left - 0.5 || r.top < c.top - 0.5 || r.right > c.right + 0.5 || r.bottom > c.bottom + 0.5) return true;
  }
  return false;
}

export interface LivePreviewWant {
  /** The character on the stage; a new one shows again. */
  character: string;
  /** Action the user picked to preview; absent plays the idle. */
  action: string | undefined;
  /** The committed appearance; changing it asks the shell to refresh the same clip. */
  appearance?: string | undefined;
  request?: number | undefined;
  /** `action` starts over at its end instead of returning to the idle. */
  loop?: boolean | undefined;
  /** `action` plays as the stage, its camera and music, standing at 0 s until `avatar.preview.control` resumes it. */
  stage?: boolean | undefined;
  /** The stage's own overlay (not running, switching) is up. */
  blocked: boolean;
}

/**
 * Keeps the shell's live preview on `stage`: reports the preview layer's rect, or the stage's without one (resize, window resize,
 * scroll and transitions, once per frame), and hides it while covered, blocked, cut off, in a hidden document, after the shell failed to draw the same
 * character and action, and on unmount. True while the shell draws the character there, so the stage can drop its art.
 * `progress` is the share done of a load that builds her anew, null while none runs (live, or only the clip changes).
 */
type PreviewPhase = { phase: 'idle' | 'loading' | 'live' } | { phase: 'failed'; message: string };

/** The shell's last `avatar.preview.onProgress`, and whether the current show has had one. */
interface LoadReport { fraction: number | null; seen: boolean }

export function useLivePreview(stage: HTMLElement | null, want: LivePreviewWant): PreviewPhase & { progress: number | null; retry: () => void } {
  const covered = usePreviewOverlay(stage);
  const loop = !!want.loop && !!want.action;
  const asStage = !!want.stage && !!want.action;
  const [status, setStatus] = useState<PreviewPhase>({ phase: 'idle' });
  const [report, setReport] = useState<LoadReport>({ fraction: null, seen: false });
  const [drawn, setDrawn] = useState(false);
  const latest = useRef({ ...want, loop, stage: asStage, off: false });
  latest.current = { ...want, loop, stage: asStage, off: covered || want.blocked };
  const schedule = useRef<() => void>(() => {});
  const retry = useRef<() => void>(() => {});
  const qc = useContext(QueryClientContext);
  const render = useRef('');

  // A saved render setting shows again; the answer to that show, a failure included, is the stage's.
  useEffect(() => {
    if (!qc) return;
    const read = () => renderSettings(qc.getQueryData(SETTINGS_KEY));
    render.current = read();
    return qc.getQueryCache().subscribe((e) => {
      if (e.type !== 'updated' || e.query.queryHash !== JSON.stringify(SETTINGS_KEY)) return;
      const next = read();
      if (next === render.current) return;
      render.current = next;
      schedule.current();
    });
  }, [qc]);

  useEffect(() => {
    const bridge = getBridge();
    if (!stage || !window.agenticComplex || bridge.surface !== 'main' || !bridge.capabilities.avatar) return;
    const preview = bridge.avatar.preview;
    const unsubscribe = preview.onProgress((p) => setReport((r) => ({ fraction: p?.fraction ?? null, seen: r.seen || p !== null })));
    let frame = 0;
    let sent = '';
    let failed = '';
    let active = '';
    let seq = 0;
    const hide = (error?: string) => {
      seq++;
      active = '';
      setStatus(error ? { phase: 'failed', message: error } : { phase: 'idle' });
      if (!sent) return;
      sent = '';
      void preview.hide().catch(() => {});
    };
    const report = () => {
      frame = 0;
      const { character, action, appearance, request, loop, stage: asStage, off } = latest.current;
      const what = `${character}|${action ?? ''}|${loop ? 'loop' : ''}|${asStage ? 'stage' : ''}|${appearance ?? ''}|${request ?? ''}`;
      const s = stage.getBoundingClientRect();
      const layer = document.querySelector(PREVIEW_LAYER) ?? stage;
      const r = layer === stage ? s : layer.getBoundingClientRect();
      // A failed show is tried again once her look or a render setting changes.
      const drawing = `${what}|${lookRevision}|${render.current}`;
      if (failed === drawing) return;
      if (off || document.hidden || s.width <= 0 || s.height <= 0 || r.width <= 0 || r.height <= 0 || clipped(layer, r)) {
        if (sent) hide();
        return;
      }
      const at: PreviewPlacement = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        ...(action ? { action } : {}),
        ...(loop ? { loop } : {}),
        ...(request != null ? { request } : {}),
        ...(asStage ? { stage: true } : {}),
      };
      // Her look changing shows again without loading anew on the page: the stage stays live unless the show fails.
      const key = `${drawing}|${at.x},${at.y},${at.w},${at.h}`;
      if (key === sent) return;
      sent = key;
      if (active !== what) {
        active = what;
        failed = '';
        setStatus({ phase: 'loading' });
        setReport((r) => ({ ...r, seen: false }));
      }
      const n = ++seq;
      const reject = () => {
        if (n !== seq) return;
        failed = drawing;
        hide('实时预览没有加载，仍可查看角色外观');
      };
      preview.show(at).then(
        (on) => {
          if (n !== seq) return;
          if (!on) return reject();
          setStatus({ phase: 'live' });
          setDrawn(true);
        },
        reject,
      );
    };
    schedule.current = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };
    retry.current = () => {
      failed = '';
      schedule.current();
    };
    const later = () => schedule.current();
    lookListeners.add(later);
    report();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(stage);
    const layer = document.querySelector(PREVIEW_LAYER);
    if (layer) ro?.observe(layer);
    window.addEventListener('resize', later);
    document.addEventListener('scroll', later, true);
    document.addEventListener('transitionend', later, true);
    document.addEventListener('animationend', later, true);
    document.addEventListener('visibilitychange', later);
    return () => {
      schedule.current = () => {};
      retry.current = () => {};
      lookListeners.delete(later);
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', later);
      document.removeEventListener('scroll', later, true);
      document.removeEventListener('transitionend', later, true);
      document.removeEventListener('animationend', later, true);
      document.removeEventListener('visibilitychange', later);
      unsubscribe();
      hide();
    };
  }, [stage]);

  const off = covered || want.blocked;
  useEffect(() => schedule.current(), [off, want.character, want.action, loop, asStage, want.appearance, want.request]);
  const placed = status.phase === 'loading' || status.phase === 'live';
  // A service that reports no progress: the first show on this stage counts 0 until her first frame.
  const progress = !placed ? null : (report.fraction ?? (status.phase === 'loading' && !drawn && !report.seen ? 0 : null));
  return { ...status, progress, retry: () => retry.current() };
}
