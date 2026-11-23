// A read that failed while agentd was starting is read again once agentd runs, without a manual 重试.
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { RuntimeSnapshot } from '../../src/bridge/runtimeSnapshot';
import { refetchFailedWhenAgentdUp } from '../../src/data/agentdUp';

const snap = (state: RuntimeSnapshot['processes']['agentd']['state']) =>
  ({ processes: { agentd: { state } } }) as unknown as RuntimeSnapshot;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('refetchFailedWhenAgentdUp', () => {
  it('re-reads a page query that failed while agentd was starting', async () => {
    const client = new QueryClient();
    let push: (s: RuntimeSnapshot) => void = () => {};
    refetchFailedWhenAgentdUp(client, (cb) => {
      push = cb;
      return () => {};
    });
    let up = false;
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['brief', 'day'],
      queryFn: () => {
        reads += 1;
        return up ? Promise.resolve('brief') : Promise.reject(new Error('agentd is unreachable'));
      },
      retry: false,
    });
    push(snap('starting'));
    const off = observer.subscribe(() => {});
    await settle();
    expect(observer.getCurrentResult().status).toBe('error');

    up = true;
    push(snap('running'));
    await settle();
    expect(reads).toBe(2);
    expect(observer.getCurrentResult().data).toBe('brief');
    off();
  });
});
