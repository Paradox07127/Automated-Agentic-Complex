import { appNow } from '../../bridge/clock';
import { MINUTE, SECOND } from '../../domain/units';
import type { ModelInit } from './model';
import type { WireDiagSlice } from './wire';

/** Initial model state per `?demo=` so every state opens by URL (route.ts demos). Confirm demos are opened by the page. */
export function demoInit(demo: string | null): ModelInit {
  // A demo starts from its own restart notice and never stores one.
  const init: ModelInit = demo ? { pending: [] } : {};
  if (demo === 'pending') init.pending = ['web'];
  if (demo === 'draft') init.draft = { maxCost: 2, kernel: 'pi' };
  // 15:02 on the fake bridge's clock (14:32:10).
  if (demo === 'dnd') init.pauses = { quiet: appNow() + 29 * MINUTE + 50 * SECOND };
  return init;
}

/**
 * `/diag/state` per `?demo=` in the browser preview: `hooks-off` has neither coding tool hooked up, so the install steps show;
 * `sparse` has one spoken line and two screenshots today.
 */
export function demoDiag(demo: string | null, d: WireDiagSlice | null): WireDiagSlice | null {
  if (!d) return d;
  if (demo === 'hooks-off') return { ...d, hooks: { claude: { installed: null, last_at: null }, codex: { installed: false, last_at: null } } };
  if (demo === 'sparse') {
    return {
      ...d,
      gate: d.gate && { ...d.gate, today: 1, blocked_today: 0, cooldown_s: { proactive: 180 } },
      budget: d.budget && { ...d.budget, screenshots: d.budget.screenshots && { ...d.budget.screenshots, used: 2, reserved: 0, released: 0 } },
    };
  }
  return d;
}
