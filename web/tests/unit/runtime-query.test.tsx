import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { refreshRuntime, RUNTIME_KEY, useRuntimePublic } from '../../src/data/runtime';
import type { WireRuntimePublic } from '../../src/domain';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function spyRequests() {
  const bridge = getBridge();
  const real = bridge.agentd.request.bind(bridge.agentd);
  return vi.spyOn(bridge.agentd, 'request').mockImplementation((method, path, body) => real(method, path, body));
}

const paths = (spy: ReturnType<typeof spyRequests>) => spy.mock.calls.map(([method, path]) => `${method} ${path}`);

describe('shared /character/runtime entry', () => {
  it('refreshRuntime requests ?refresh=1 and writes the reply into [runtime]', async () => {
    const spy = spyRequests();
    const qc = new QueryClient();
    const stale = { ready: false } as WireRuntimePublic;
    qc.setQueryData(RUNTIME_KEY, stale);
    const r = await refreshRuntime(qc);
    expect(paths(spy)).toEqual(['GET /character/runtime?refresh=1']);
    expect(Array.isArray(r.available_backends)).toBe(true);
    expect(qc.getQueryData(RUNTIME_KEY)).toEqual(r);
  });

  it('every reader shares one request, and a refresh reaches them all', async () => {
    const spy = spyRequests();
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const hook = renderHook(() => [useRuntimePublic(), useRuntimePublic({ select: (w) => w.ready })] as const, { wrapper });
    await waitFor(() => expect(hook.result.current[0].data).toBeDefined());
    expect(paths(spy)).toEqual(['GET /character/runtime']);
    const r = await refreshRuntime(qc);
    await waitFor(() => expect(hook.result.current[0].data).toEqual(r));
    expect(hook.result.current[1].data).toBe(r.ready);
  });

  it('a poll still in flight when a refresh answers does not write its older reply back', async () => {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const before = { ready: false, available_backends: [] } as unknown as WireRuntimePublic;
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
      path === '/character/runtime' ? (await held, { status: 200, body: before }) : real(method, path, body),
    );
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useRuntimePublic(), { wrapper });
    await waitFor(() => expect(hook.result.current.fetchStatus).toBe('fetching'));
    const r = await refreshRuntime(qc);
    release();
    await waitFor(() => expect(hook.result.current.fetchStatus).toBe('idle'));
    expect(qc.getQueryData(RUNTIME_KEY)).toEqual(r);
  });

  it('under the fake bridge a demo goes along with the refresh and keeps its own entry', async () => {
    const spy = spyRequests();
    const qc = new QueryClient();
    const r = await refreshRuntime(qc, 'logged-out');
    expect(paths(spy)).toEqual(['GET /character/runtime?refresh=1&demo=logged-out']);
    expect(r.error).toBe('native_login_required');
    expect(qc.getQueryData([...RUNTIME_KEY, 'logged-out'])).toEqual(r);
    expect(qc.getQueryData(RUNTIME_KEY)).toBeUndefined();
  });
});
