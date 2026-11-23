import type { QueryClient } from '@tanstack/react-query';
import type { Unsubscribe } from '../bridge/protocol';
import type { RuntimeSnapshot } from '../bridge/runtimeSnapshot';

/**
 * Each time agentd turns running, re-reads every query that failed. Pages open while agentd starts or restarts, and
 * their reads (retry off) would keep 「agentd is unreachable」 until a manual 重试.
 */
export function refetchFailedWhenAgentdUp(client: QueryClient, onRuntime: (cb: (s: RuntimeSnapshot) => void) => Unsubscribe): Unsubscribe {
  let up = true;
  return onRuntime((s) => {
    const now = s.processes.agentd.state === 'running';
    if (now && !up) void client.refetchQueries({ predicate: (q) => q.state.status === 'error' });
    up = now;
  });
}
