import type { WireFact } from '../domain/wire';
import type { MockResponse, MockRoute } from './types';

// GET /memory/facts/{id}/cascade, DELETE /memory/facts/{id}, and the check PATCH makes, over the facts src/mock/memory.ts keeps.

const episode = (ref: string) => (ref.startsWith('episode:') ? ref.split('@')[0] : null);

/** memory.py `tombstoned`: the other facts citing one of f's episodes, by id. */
export const cascadeOf = (facts: WireFact[], f: WireFact) =>
  facts
    .filter((x) => x !== f && x.evidence.some((r) => episode(r) != null && f.evidence.map(episode).includes(episode(r))))
    .sort((a, b) => (a.fact_id < b.fact_id ? -1 : 1));

/** 409 when `seen`, the cascade the client previewed, is not f's cascade now; null when it is. */
export const cascadeChanged = (facts: WireFact[], f: WireFact, seen: string[]): MockResponse | null => {
  const ids = cascadeOf(facts, f).map((x) => x.fact_id);
  return [...new Set(seen)].sort().join(',') === ids.join(',') ? null : { status: 409, body: { error: 'cascade_changed', fact_ids: ids } };
};

// PATCH keeps the cascade, so a demo can correct each; DELETE takes it.
export const factCascadeRoutes = (facts: () => WireFact[], setFacts: (next: WireFact[]) => void): MockRoute[] => [
  {
    method: 'GET',
    path: '/memory/facts/:id/cascade',
    handler: ({ params }) => {
      const f = facts().find((x) => x.fact_id === params.id);
      return f ? { status: 200, body: { fact_ids: cascadeOf(facts(), f).map((x) => x.fact_id) } } : { status: 404, body: { error: 'unknown_fact' } };
    },
  },
  {
    method: 'DELETE',
    path: '/memory/facts/:id',
    handler: ({ params, query }) => {
      const v = Number(query.get('expected_version') ?? 'x');
      if (!Number.isInteger(v)) return { status: 400, body: { error: 'expected_version_required' } };
      const seen = query.get('cascade');
      if (seen == null) return { status: 400, body: { error: 'cascade_required' } };
      const f = facts().find((x) => x.fact_id === params.id);
      if (!f) return { status: 404, body: { error: 'unknown_fact' } };
      if (f.version !== v) return { status: 409, body: { error: 'version_conflict', current_version: f.version } };
      const changed = cascadeChanged(facts(), f, seen.split(',').filter(Boolean));
      if (changed) return changed;
      const gone = cascadeOf(facts(), f);
      setFacts(facts().filter((x) => x !== f && !gone.includes(x)));
      return { status: 200, body: { deleted: true } };
    },
  },
];
