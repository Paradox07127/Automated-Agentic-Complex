import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { S_C07A } from '../../src/mock/fixtures/ids';
import { useSessionLines, watchTasksFeed } from '../../src/pages/tasks/useTasksData';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

describe('an own coding session’s lines are read on its session line feed event', () => {
  it('reads once on open, never on a timer, and again only when the event says there is more', async () => {
    vi.useFakeTimers();
    let onEvent: ((e: StreamEvent) => void) | null = null;
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const real = bridge.agentd.request.bind(bridge.agentd);
    const reads: string[] = [];
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      if (path.startsWith(`/sessions/${S_C07A}/lines`)) reads.push(path);
      return (await real(method, path, body)) as never;
    });
    window.agenticComplex = { ...bridge, feed: { subscribe: (e: (x: StreamEvent) => void) => ((onEvent = e), () => {}) } } as never;
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSessionLines(S_C07A, 0), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(100));
    const first = result.current.data ?? [];
    expect(first.length).toBeGreaterThan(0);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toHaveLength(1);
    const emit = (data: Record<string, unknown>) => act(async () => {
      onEvent?.({ event: 'session', id: null, data: JSON.stringify({ kind: 'line', ...data }) });
      await vi.advanceTimersByTimeAsync(100);
    });
    await emit({ session_id: 'own:other', seq: first.length + 1 });
    await emit({ session_id: S_C07A, seq: first.length });
    expect(reads).toHaveLength(1);
    await emit({ session_id: S_C07A, seq: first.length + 1 });
    expect(reads).toHaveLength(2);
    expect(reads[1]).toContain(`after=${first.length}`);
    expect(result.current.data).toEqual(first);
    client.clear();
  });

  it('a transcript line does not reload the task rows; a session state change does', () => {
    const hub: { on?: (e: StreamEvent) => void } = {};
    window.agenticComplex = { ...createFakeBridge({ surface: 'main', still: true }), feed: { subscribe: (e: (x: StreamEvent) => void) => ((hub.on = e), () => {}) } } as never;
    const changes: string[] = [];
    const stop = watchTasksFeed(() => {}, (what) => changes.push(what), () => false);
    hub.on?.({ event: 'session', id: null, data: JSON.stringify({ session_id: S_C07A, kind: 'line', seq: 3 }) });
    expect(changes).toEqual([]);
    hub.on?.({ event: 'session', id: null, data: JSON.stringify({ session_id: S_C07A, kind: 'state', state: 'done' }) });
    expect(changes).toEqual(['base']);
    stop();
  });
});
