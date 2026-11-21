// @vitest-environment node
// The generated agentd route module must say the same as protocol/ui-bridge/routes.json, and each template must reach its own route.
import { describe, expect, it } from 'vitest';
import { AGENTD_ROUTES, type AgentdRouteKey } from '../../src/bridge/agentd-routes.generated';
import { loadRoutes, matchRoute, type RouteEntry } from '../../scripts/route-contract.ts';

const routes = loadRoutes();
const wire = (r: Omit<RouteEntry, 'surfaces'> & { surfaces: readonly string[] }) => JSON.stringify([r.method, r.path, r.class, [...r.surfaces]]);
// Fillings for `:name` segments; the prefixed ones are for ids the registry patterns require a prefix on.
const SAMPLES = ['0123456789ab', '0123456789abcdef0123456789abcdef', '01234567-89ab-cdef-0123-456789abcdef', 'job:0123456789ab', 'task:0123456789ab', 'own:0123456789ab', '1', 'x1', '2026-11-04', 'delivery-0123456789abcdef0123456789abcdef', 'obs-0123456789abcdef0123456789abcdef', 'work-0123456789abcdef0123456789abcdef', 'brief-0123456789abcdef0123456789abcdef', 'gm-0123456789abcdef'];

function* fillings(template: string): Generator<string> {
  const parts = template.split(/:[A-Za-z_]\w*/);
  const slots = parts.length - 1;
  for (let k = 0; k < SAMPLES.length ** slots; k += 1) {
    let path = parts[0] ?? '';
    for (let s = 0; s < slots; s += 1) path += `${SAMPLES[Math.floor(k / SAMPLES.length ** (slots - 1 - s)) % SAMPLES.length]}${parts[s + 1]}`;
    yield path;
  }
}

describe('agentd-routes.generated', () => {
  it('lets the stack surface read the runtime, which the menu-bar console shows as 内核', () => {
    expect(matchRoute('GET', '/character/runtime', routes)?.surfaces).toContain('stack');
  });

  it('has the same routes as routes.json', () => {
    expect(AGENTD_ROUTES.length).toBe(routes.length);
    expect(new Set(AGENTD_ROUTES.map(wire))).toEqual(new Set(routes.map(wire)));
  });

  it('gives every route at least one template, and every template matches its own route', () => {
    const misses: string[] = [];
    for (const r of AGENTD_ROUTES) {
      if (r.templates.length === 0) misses.push(`${r.method} ${r.path}: no template`);
      for (const t of r.templates) {
        const own = [...fillings(t)].some((p) => {
          const hit = matchRoute(r.method, p, routes);
          return hit !== null && wire(hit) === wire(r);
        });
        if (!own) misses.push(`${r.method} ${t}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('types a key per method and template', () => {
    const keys: AgentdRouteKey[] = ['GET /health', 'POST /approvals/0123/decision', 'DELETE /conversations/abc'];
    // @ts-expect-error a method the route does not take
    const wrong: AgentdRouteKey = 'DELETE /health';
    expect([...keys, wrong]).toHaveLength(4);
  });
});
