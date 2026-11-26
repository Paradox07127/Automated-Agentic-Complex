import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { fromApproval, fromInteraction, sortPending, type PendingItem } from '../../src/domain';
import type { WireTraceTurn } from '../../src/domain';
import { isoWithOffset } from '../../src/domain/units';
import { routes as diagRoutes } from '../../src/mock/diag';
import { NOW } from '../../src/mock/fixtures';
import { routes as overviewRoutes } from '../../src/mock/overview';
import { routes as sharedRoutes } from '../../src/mock/shared';
import { turnsView } from '../../src/pages/diag/model';
import type { WireDiagState } from '../../src/domain/wire';
import type { WireTraceEvent } from '../../src/pages/diag/wire';
import type { WireAgentSnapshot } from '../../src/pages/overview/wire';

const request = createDispatcher([...overviewRoutes, ...diagRoutes, ...sharedRoutes]);
const get = async <T>(path: string) => (await request<T>('GET', path)).body as T;

/** Approvals and questions in an `/agent/snapshot`; deliveries still undecided are the reviews. */
const decisionsOf = (s: WireAgentSnapshot): PendingItem[] => [
  ...(s.approvals?.approvals ?? []).map((a) => fromApproval(a, NOW)),
  ...(s.interactions?.requests ?? []).map((q) => fromInteraction(q, NOW)),
];
const reviewsOf = (s: WireAgentSnapshot) => (s.deliveries?.deliveries ?? []).filter((d) => d.decided_at == null);

describe('overview snapshot', () => {
  it('puts the dangerous approval first and keeps PENDING as the only source', async () => {
    const s = await get<WireAgentSnapshot>('/agent/snapshot');
    const first = sortPending(decisionsOf(s))[0];
    expect(first?.kind === 'approval' && first.dangerous).toBe(true);
    expect(decisionsOf(s).length + reviewsOf(s).length).toBe(5);
  });

  it('nowait leaves errors to be promoted into 01', async () => {
    const s = await get<WireAgentSnapshot>('/agent/snapshot?demo=nowait');
    expect(decisionsOf(s)).toEqual([]);
    expect(reviewsOf(s)).toEqual([]);
    expect(s.personal_tasks?.tasks.filter((t) => t.state === 'failed').length).toBeGreaterThan(0);
  });

  it('fail returns an error the page can show', async () => {
    const r = await request('GET', '/agent/snapshot?fail=1');
    expect(r.status).toBe(500);
    expect(r.error?.code).toBe('internal_error');
  });
});

describe('diag mocks', () => {
  it('keeps usage readouts consistent: the model totals equal the by_call sums', async () => {
    const d = await get<WireDiagState>('/diag/state');
    const m = d.budget.model!;
    const calls = Object.values(m.by_call);
    expect(calls.reduce((n, c) => n + c.calls, 0)).toBe(m.calls);
    expect(calls.reduce((n, c) => n + c.input_tokens + c.output_tokens, 0)).toBe(m.input_tokens + m.output_tokens);
  });

  it('hourly failure bars count exactly the failed turns', async () => {
    for (const days of [1, 7]) {
      const start = NOW - days * 86_400_000;
      const r = await get<{ turns: WireTraceTurn[] }>(`/trace/turns?since=${encodeURIComponent(isoWithOffset(start))}&limit=200`);
      const t = turnsView(r.turns, start, NOW);
      expect(t.failures_per_hour.reduce((a, b) => a + b, 0)).toBe(t.turns.filter((x) => x.result === 'failed').length);
      expect(t.turns.length).toBeLessThanOrEqual(200);
    }
  });

  it('decisions that carry a turn_id find their row in the 24 h turn list', async () => {
    const r = await get<{ events: WireTraceEvent[] }>('/trace/decisions?limit=100');
    const linked = r.events.filter((e) => e.turn_id != null);
    expect(linked.length).toBeGreaterThan(0);
    const t = await get<{ turns: WireTraceTurn[] }>(`/trace/turns?since=${encodeURIComponent(isoWithOffset(NOW - 86_400_000))}&limit=200`);
    for (const e of linked) expect(t.turns.find((x) => x.turn_id === e.turn_id)?.trace_id).toBe(e.trace_id);
  });
});
