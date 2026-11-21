/** Shared motion helpers of the game effect kit (ui/fx). */

/** Jump to end states instead of animating: still screenshots (`html.still`), the reduce-motion switch, or the system setting. */
export function fxCalm(): boolean {
  if (typeof window === 'undefined') return true;
  const root = document.documentElement;
  // The shell sets `html.still` in an effect, which runs after its children's first clips; the URL already says it.
  const query = window.location.hash.split('?')[1] ?? '';
  return (
    root.classList.contains('still') ||
    new URLSearchParams(query).get('still') === '1' ||
    root.hasAttribute('data-reduce-motion') ||
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  );
}

/** A duration token (`--ef-<name>`) read on an element, in ms; fallback where tokens.css is not loaded. */
export function tokenMs(el: Element, name: string, fallback: number): number {
  const v = getComputedStyle(el).getPropertyValue(`--ef-${name}`).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n;
}

export function tokenEase(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(`--ef-${name}`).trim() || fallback;
}

/** `el.animate`, or null where the element cannot animate (jsdom has no Web Animations). */
export function animate(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  return typeof el.animate === 'function' ? el.animate(keyframes, options) : null;
}

/** Entrance helper: plays once and drops the animation when it ends, so nothing stays attached at rest. */
export function playOnce(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (fxCalm()) return null;
  const a = animate(el, keyframes, { fill: 'backwards', ...options });
  a?.finished.then(
    () => a.cancel(),
    () => undefined,
  );
  return a;
}
