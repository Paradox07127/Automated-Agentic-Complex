import type { WireFact, WireFactVersion } from '../domain/wire';
import type { MockRoute } from './types';
import { V31_VERSIONS } from './memory-v31';

// GET /memory/facts/{id}/versions and PUT …/locked, …/quiet over the facts src/mock/memory.ts keeps.

/** Versions per fact; a fact absent here has only its current version. */
const versions: Record<string, WireFactVersion[]> = { ...V31_VERSIONS };
const current = (f: WireFact): WireFactVersion => ({ version: f.version, text: f.text, source: f.source, by: 'user', at: f.recorded_at });
export const versionsOf = (f: WireFact) => versions[f.fact_id] ?? [current(f)];
/** memory.py `_revise` wrote f's new version; `kept` is what versionsOf(f) gave before it. */
export const addVersion = (f: WireFact, kept: WireFactVersion[]) => void (versions[f.fact_id] = [...kept, current(f)]);

const unknown = { status: 404, body: { error: 'unknown_fact' } };

export const factVersionRoutes = (facts: () => WireFact[]): MockRoute[] => [
  {
    method: 'GET',
    path: '/memory/facts/:id/versions',
    handler: ({ params }) => {
      const f = facts().find((x) => x.fact_id === params.id);
      return f ? { status: 200, body: { versions: versionsOf(f) } } : unknown;
    },
  },
  ...(['locked', 'quiet'] as const).map(
    (mark): MockRoute => ({
      method: 'PUT',
      path: `/memory/facts/:id/${mark}`,
      handler: ({ params, body }) => {
        const on = body != null && typeof body === 'object' ? (body as Record<string, unknown>)[mark] : undefined;
        if (typeof on !== 'boolean') return { status: 400, body: { error: 'invalid_payload' } };
        const f = facts().find((x) => x.fact_id === params.id);
        if (!f) return unknown;
        f[mark] = on;
        return { status: 200, body: { [mark]: on } };
      },
    }),
  ),
];
