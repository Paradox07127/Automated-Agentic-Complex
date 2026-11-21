import { useQuery, type QueryClient } from '@tanstack/react-query';
import { get } from '../bridge/agentd';
import type { WireRuntimePublic } from '../domain';

/** The one cache entry for `GET /character/runtime`: the sidebar, ⌘K and every page read it. */
export const RUNTIME_KEY = ['runtime'] as const;

/** agentd answers these at once while its first runtime probe runs in the background. */
const PENDING: ReadonlySet<string> = new Set(['runtime_discovery_pending', 'runtime_probe_pending']);

/** `demo` reaches only the fake bridge's mock, under its own entry. */
const fakeDemo = (demo: string | null | undefined) => (!window.agenticComplex && demo ? demo : null);

export const runtimeKey = (demo?: string | null) => {
  const d = fakeDemo(demo);
  return d ? [...RUNTIME_KEY, d] : RUNTIME_KEY;
};

export function useRuntimePublic<T = WireRuntimePublic>({ demo, select }: { demo?: string | null; select?: (r: WireRuntimePublic) => T } = {}) {
  return useQuery({
    queryKey: runtimeKey(demo),
    queryFn: () => {
      const d = fakeDemo(demo);
      return get<WireRuntimePublic>(`/character/runtime${d ? `?demo=${d}` : ''}`);
    },
    select,
    staleTime: 30_000,
    refetchInterval: (q) => (PENDING.has(q.state.data?.error ?? '') ? 1_000 : 15_000),
    retry: false,
  });
}

/** 重新检测: agentd rescans the installed runtimes (`refresh=1`); the reply replaces the shared entry. */
export async function refreshRuntime(qc: QueryClient, demo?: string | null): Promise<WireRuntimePublic> {
  const d = fakeDemo(demo);
  const r = await get<WireRuntimePublic>(`/character/runtime?refresh=1${d ? `&demo=${d}` : ''}`);
  qc.setQueryData(runtimeKey(demo), r);
  return r;
}
