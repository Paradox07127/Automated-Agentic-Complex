import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';

export { useGo, type Go, type NavTarget } from '../../shell/nav';

/** Page-specific URL params (`tab`, `sel`, `item` …) as strings; the router may have parsed `1` into a number. */
export function useParam(name: string): string | null {
  return useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>)[name];
      return v == null ? null : String(v);
    },
  });
}

/** Server clock: starts at the snapshot's `now` and ticks each second unless `still`. */
export function useNow(base: number | undefined, still: boolean): number {
  const [now, setNow] = useState(base ?? 0);
  useEffect(() => {
    if (base == null) return;
    setNow(base);
    if (still) return;
    const t0 = Date.now();
    const id = setInterval(() => setNow(base + Date.now() - t0), 1000);
    return () => clearInterval(id);
  }, [base, still]);
  return now;
}

export { call } from '../../bridge/agentd';
