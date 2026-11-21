import type { RegionSource } from '../../ui/useRegion';

type Read = Pick<RegionSource<unknown>, 'status' | 'data' | 'error' | 'isFetching' | 'dataUpdatedAt' | 'refetch'>;

/**
 * One section's Region source over several reads: it has data once every `need` read has data and every `soft` read has
 * answered either way; a failed `need` read fails it, a failed `soft` read only blanks its own part.
 */
export function joined(need: readonly Read[], soft: readonly Read[] = []): RegionSource<true> {
  const failed = need.find((q) => q.status === 'error');
  const ready = need.every((q) => q.data !== undefined) && soft.every((q) => q.data !== undefined || q.status === 'error');
  const times = need.flatMap((q) => (q.dataUpdatedAt ? [q.dataUpdatedAt] : []));
  return {
    status: failed ? 'error' : ready ? 'success' : 'pending',
    data: ready ? true : undefined,
    error: failed?.error,
    isFetching: [...need, ...soft].some((q) => q.isFetching),
    dataUpdatedAt: times.length ? Math.min(...times) : 0,
    refetch: () => [...need, ...soft.filter((q) => q.status === 'error')].forEach((q) => void q.refetch?.()),
  };
}
