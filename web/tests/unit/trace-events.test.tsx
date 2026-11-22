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
import { TracePage } from '../../src/pages/trace/Page';

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
  const root = createRootRoute({ component: TracePage });
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
    const board = await screen.findByRole('region', { name: '动作线' });
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
    expect(screen.getByRole('status').textContent).toContain('读不到');
  });
});
