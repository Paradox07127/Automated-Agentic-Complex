import type { AgenticComplexBridge } from './protocol';

export type * from './protocol';

declare global {
  interface Window {
    /** Injected by the shell; absent in a plain browser. */
    agenticComplex?: AgenticComplexBridge;
  }
}

type FakeModule = typeof import('./fake');

let fake: FakeModule | undefined;
// Unit tests get the fake bridge with this module; the pages load it through `loadFakeBridge`, so the app never fetches it.
if (import.meta.env.MODE === 'test') fake = await import('./fake');

/** A plain browser (dev, e2e) has no `window.agenticComplex`: each entry awaits this before its first render. */
export async function loadFakeBridge(): Promise<void> {
  if (import.meta.env.MODE === 'app' || window.agenticComplex) return;
  fake ??= await import('./fake');
}

let fallback: AgenticComplexBridge | undefined;

/** Native bridge when the shell injected one, otherwise a shared fake bridge. */
export function getBridge(): AgenticComplexBridge {
  if (window.agenticComplex) return window.agenticComplex;
  // The shell opens the first-run guide as main.html#/onboarding on its own `onboarding` surface.
  const surface = document.documentElement.dataset.surface === 'stack' ? 'stack' : window.location.hash.startsWith('#/onboarding') ? 'onboarding' : 'main';
  if (!fake) throw new Error('no window.agenticComplex and the fake bridge is not loaded (loadFakeBridge)');
  fallback ??= fake.createFakeBridge({ surface });
  return fallback;
}
