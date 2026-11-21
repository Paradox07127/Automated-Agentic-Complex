// The shell draws the live preview natively over the page, so anything the page draws over the stage has to make it hide.
import { useEffect, useRef, useState } from 'react';
import { getBridge, type PreviewPlacement } from '../../bridge';
import { MODAL_ROOT_ID } from '../../ui';

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether the page draws something over `stage`: a dialog or sheet in the modal root, any dialog (the command palette
 * included), or a menu, dropdown list or toast that overlaps the stage.
 */
export function previewCovered(stage: Element): boolean {
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
  /** The stage's own overlay (not running, switching) is up. */
  blocked: boolean;
}

/**
 * Keeps the shell's live preview over `stage`: reports its rect (resize, window resize, scroll and transitions, once per
 * frame) and hides it while covered, blocked, cut off, in a hidden document, after the shell failed to draw the same
 * character and action, and on unmount. True while the shell draws the character there, so the stage can drop its art.
 */
type PreviewPhase = { phase: 'idle' | 'loading' | 'live' } | { phase: 'failed'; message: string };

export function useLivePreview(stage: HTMLElement | null, want: LivePreviewWant): PreviewPhase & { retry: () => void } {
  const covered = usePreviewOverlay(stage);
  const loop = !!want.loop && !!want.action;
  const [status, setStatus] = useState<PreviewPhase>({ phase: 'idle' });
  const latest = useRef({ ...want, loop, off: false });
  latest.current = { ...want, loop, off: covered || want.blocked };
  const schedule = useRef<() => void>(() => {});
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    const bridge = getBridge();
    if (!stage || !window.agenticComplex || bridge.surface !== 'main' || !bridge.capabilities.avatar) return;
    const preview = bridge.avatar.preview;
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
      const { character, action, appearance, request, loop, off } = latest.current;
      const what = `${character}|${action ?? ''}|${loop ? 'loop' : ''}|${appearance ?? ''}|${request ?? ''}`;
      const r = stage.getBoundingClientRect();
      if (failed === what) return;
      if (off || document.hidden || r.width <= 0 || r.height <= 0 || clipped(stage, r)) {
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
      };
      const key = `${what}|${at.x},${at.y},${at.w},${at.h}`;
      if (key === sent) return;
      sent = key;
      if (active !== what) {
        active = what;
        failed = '';
        setStatus({ phase: 'loading' });
      }
      const n = ++seq;
      const reject = () => {
        if (n !== seq) return;
        failed = what;
        hide('实时预览没有加载，仍可查看角色外观');
      };
      preview.show(at).then(
        (on) => {
          if (n !== seq) return;
          if (on) setStatus({ phase: 'live' });
          else reject();
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
    report();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(stage);
    window.addEventListener('resize', later);
    document.addEventListener('scroll', later, true);
    document.addEventListener('transitionend', later, true);
    document.addEventListener('animationend', later, true);
    document.addEventListener('visibilitychange', later);
    return () => {
      schedule.current = () => {};
      retry.current = () => {};
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', later);
      document.removeEventListener('scroll', later, true);
      document.removeEventListener('transitionend', later, true);
      document.removeEventListener('animationend', later, true);
      document.removeEventListener('visibilitychange', later);
      hide();
    };
  }, [stage]);

  const off = covered || want.blocked;
  useEffect(() => schedule.current(), [off, want.character, want.action, loop, want.appearance, want.request]);
  return { ...status, retry: () => retry.current() };
}
