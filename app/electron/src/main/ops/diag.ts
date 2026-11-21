// `diag.subscribe`/`diag.unsubscribe`: agentd's `/diag/stream`, connected while a page subscribes; no replay.
import { BridgeFailure } from '../../common/bridge.ts';
import type { Ops, OpsContext } from './context.ts';
import { subscriptionId } from './events.ts';

export function diagOps(ctx: OpsContext): Ops {
  return {
    'diag.subscribe': ([id], page) => {
      if (!ctx.diag) throw new BridgeFailure('not_implemented', 'diag.subscribe');
      page.subscribe(page.generation, 'diag', subscriptionId(id), ctx.diag, null);
      return null;
    },
    'diag.unsubscribe': ([id], page) => {
      page.unsubscribe(page.generation, 'diag', subscriptionId(id));
      return null;
    },
  };
}
