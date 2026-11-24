// `GET /trace/events` through the bridge, and the 动作线 tab reading its stretch from it page after page.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { appNow } from '../../src/bridge/clock';
import { createFakeBridge } from '../../src/bridge/fake';
import { demoTraceEvents } from '../../src/bridge/fake/traceEvents';
import { traceEvents } from '../../src/bridge/traceEvents';
import { isoToMs, isoWithOffset } from '../../src/domain';
import type { MockHandler } from '../../src/mock/types';
import type { WireTraceTurn } from '../../src/domain/wire';
import { DiagPage } from '../../src/pages/diag/Page';
import { buildTurn } from '../../src/pages/trace/steps';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.agenticComplex;
});

describe('traceEvents', () => {
  it('sends the range, kinds and cursor, and the fake pages the demo stretch as agentd does', async () => {
    const now = appNow();
    const all = demoTraceEvents(now);
    const [since, until] = [isoWithOffset(now - 200_000), isoWithOffset(now - 60_000)];
    const inRange = all.filter((e) => isoToMs(e.t_wall) >= isoToMs(since) && isoToMs(e.t_wall) <= isoToMs(until));
    expect(inRange.length).toBeGreaterThan(5);
    const seen = [];
    let cursor: string | null = null;
    do {
      const page = await traceEvents({ since, until, limit: 5, cursor });
      expect(page.events.length).toBeLessThanOrEqual(5);
      seen.push(...page.events);
      cursor = page.cursor;
    } while (cursor != null);
    expect(seen.map((e) => e.event_id)).toEqual(inRange.map((e) => e.event_id));
    const kinds = await traceEvents({ kinds: ['stage.changed', 'behavior.refused'] });
    expect(new Set(kinds.events.map((e) => e.kind))).toEqual(new Set(['stage.changed', 'behavior.refused']));
    expect(kinds.cursor).toBeNull();
    await expect(traceEvents({ since: '2026-11-22T10:00:00' })).rejects.toMatchObject({ status: 400, code: 'invalid_query' });
  });
});

function mount(handler: MockHandler) {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true, routes: [{ method: 'GET', path: '/trace/events', handler }] });
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1&tab=lanes'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('运行记录 动作线 reads /trace/events', () => {
  it('reads the last hour and follows the cursor to the end', async () => {
    // With a shell bridge the app clock is the wall clock.
    const all = demoTraceEvents(Date.now());
    const asked: URLSearchParams[] = [];
    mount(({ query }) => {
      asked.push(query);
      return { status: 200, body: query.get('cursor') == null ? { events: all.slice(0, 30), cursor: 'p2' } : { events: all.slice(30), cursor: null } };
    });
    const board = await screen.findByRole('region', { name: '事件线' });
    await within(board).findByRole('group', { name: '注意力' });
    expect(asked.map((q) => q.get('cursor'))).toEqual([null, 'p2']);
    const [since, until] = [asked[0]!.get('since')!, asked[0]!.get('until')!];
    expect(isoToMs(until) - isoToMs(since)).toBe(60 * 60_000);
    expect(Math.abs(isoToMs(until) - Date.now())).toBeLessThan(60_000);
    // A mark from the first page and one from the second are both drawn.
    expect(within(screen.getByRole('group', { name: '粗判' })).getAllByRole('button').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('group', { name: '注意力' })).getByRole('button', { name: /side → left$/ })).toBeTruthy();
  });

  it('says it cannot read when agentd refuses', async () => {
    mount(() => ({ status: 503, body: { error: 'no_trace' } }));
    expect(await screen.findByText('读不到这段时间的事件')).toBeTruthy();
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toContain('读不到');
  });
});

describe('经过 approval steps', () => {
  const row = (result: string): WireTraceTurn => ({ trace_id: 't1', turn_id: 'u1', source: 'text', head: null, len: 2, producers: ['agentd'],
    started_at: '2026-11-24T10:00:00.000Z', result, duration_ms: 5000 });
  const at = (ms: number) => `2026-11-24T10:00:0${ms / 1000}Z`;
  const ask = (id: string, ms: number) => ({ kind: 'approval.opened', status: 'ok', t_wall: at(ms), attrs: { request_id: id, tool: 'Bash' } });
  const stepOf = (result: string, events: Parameters<typeof buildTurn>[0]['events']) => buildTurn({ row: row(result), events }).steps.filter((s) => s.icon === 'shield');

  it('names and lamps each ask by what became of it', () => {
    const steps = stepOf('ok', [
      ask('a', 1000), { kind: 'approval.decided', status: 'ok', t_wall: at(2000), attrs: { request_id: 'a', tool: 'Bash', decision: 'allow', by: 'card' } },
      ask('b', 1000), { kind: 'approval.decided', status: 'ok', t_wall: at(3000), attrs: { request_id: 'b', tool: 'Bash', decision: 'deny', by: 'native' } },
      ask('c', 1000), { kind: 'approval.retired', status: 'ok', t_wall: at(4000), attrs: { request_id: 'c', tool: 'Bash', reason: 'expired' } },
      ask('d', 1000),
    ]);
    expect(steps.map((s) => [s.id, s.name, s.st])).toEqual([
      ['ask-a', '已允许', 'ok'], ['ask-b', '已拒绝', 'fail'], ['ask-c', '已收回', 'skip'], ['ask-d', '待批准', 'wait'],
    ]);
  });

  it('an ask nobody decided in a closed turn waited until the turn ended', () => {
    const [step] = stepOf('ok', [ask('d', 1000)]);
    expect(step!.dur).toBe(4000);
  });
});
