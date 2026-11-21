// `feed.subscribe`/`feed.unsubscribe`: agentd's `/feed` with replay after the page's `afterSeq`.
import { BridgeFailure } from '../../common/bridge.ts';
import { FeedSource } from '../../common/feed.ts';
import type { Ops, OpsContext } from './context.ts';
import { subscriptionId } from './events.ts';

export function feedOps(ctx: OpsContext): Ops {
  const source = ctx.store && new FeedSource(ctx.store);
  return {
    'feed.subscribe': ([id, afterSeq], page) => {
      if (!source) throw new BridgeFailure('not_implemented', 'feed.subscribe');
      page.subscribe(page.generation, 'feed', subscriptionId(id), source, typeof afterSeq === 'string' ? afterSeq : null);
      return null;
    },
    'feed.unsubscribe': ([id], page) => {
      page.unsubscribe(page.generation, 'feed', subscriptionId(id));
      return null;
    },
  };
}
