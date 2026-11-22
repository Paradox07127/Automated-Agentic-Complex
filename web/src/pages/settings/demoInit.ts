import { WIPE } from './groups/Data';
import type { ModelInit } from './model';
import type { WireDiagSlice } from './wire';

/** Initial model state per `?demo=` so every state opens by URL (route.ts demos). Confirm demos are opened by the page. */
export function demoInit(demo: string | null): ModelInit {
  // A demo starts from its own restart notice and never stores one.
  const init: ModelInit = demo ? { pending: [] } : {};
  if (demo === 'pending') init.pending = ['shot'];
  if (demo === 'draft') init.draft = { maxCost: 2, kernel: 'pi' };
  if (demo === 'confirm-wipe') init.confirm = { ...WIPE, onConfirm: () => undefined };
  return init;
}

/** `/diag/state` per `?demo=` in the browser preview: `hooks-off` has neither coding tool hooked up, so the install steps show. */
export function demoDiag(demo: string | null, d: WireDiagSlice | null): WireDiagSlice | null {
  if (!d) return d;
  if (demo === 'hooks-off') return { ...d, hooks: { claude: { installed: null, last_at: null }, codex: { installed: false, last_at: null } } };
  return d;
}
