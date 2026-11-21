// `events.unsubscribe`: ends a watch op's subscription (the shim's `on<Name>` unsubscribe); and the watch ops' shared
// subscribe step.
import ops from '../../../../../protocol/ui-bridge/ops.json' with { type: 'json' };
import { BridgeFailure } from '../../common/bridge.ts';
import type { EventSource, PageSession } from '../../common/page.ts';
import type { Ops, OpsContext } from './context.ts';

/** The shim's subscription id; invalid_args otherwise. */
export function subscriptionId(id: unknown): number {
  if (!Number.isInteger(id)) throw new BridgeFailure('invalid_args', 'subscription id');
  return id as number;
}

/** A watch op's handler: subscribes the page to `source` under the op's name. */
export function watch(op: string, source: EventSource): (args: unknown[], page: PageSession) => null {
  return ([id], page) => {
    page.subscribe(page.generation, op, subscriptionId(id), source, null);
    return null;
  };
}

export function eventsOps(_ctx: OpsContext): Ops {
  return {
    'events.unsubscribe': ([id], page) => {
      const n = subscriptionId(id);
      for (const op of ops.kinds.watch) page.unsubscribe(page.generation, op, n);
      return null;
    },
  };
}
