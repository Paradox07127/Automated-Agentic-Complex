// `window.onRoute`, the main window's one window op: the routes the shell sends the page (tray items, other windows).
// The others belong to the desktop overlay windows.
import type { Ops, OpsContext } from './context.ts';
import { subscriptionId } from './events.ts';

export function windowOps(_ctx: OpsContext): Ops {
  return {
    'window.onRoute': ([id], page) => {
      page.onRoute(page.generation, subscriptionId(id));
      return null;
    },
  };
}
