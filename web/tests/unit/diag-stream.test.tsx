// Diag: a streamed `state` carries the feed's `seq` beside the blocks (feed.py Feed.publish).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, StreamEvent } from '../../src/bridge/protocol';
import { DIAG_STATE } from '../../src/mock/diag';
import { NOW } from '../../src/mock/fixtures';
import { DiagPage } from '../../src/pages/diag/Page';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.useRealTimers();
});

it('a streamed state with seq keeps the diag page up', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  let push: (e: StreamEvent) => void = () => {};
  const fake = createFakeBridge({ surface: 'main' });
  const bridge: AgenticComplexBridge = { ...fake, diag: { subscribe: (on) => ((push = on), () => {}) } };
  window.agenticComplex = bridge;
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?tab=state'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: '主动发言闸门' });
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  act(() => push({ event: 'state', id: 'b-270', data: JSON.stringify({ seq: 270, ...DIAG_STATE }) } as StreamEvent));
  expect(await screen.findByRole('region', { name: '主动发言闸门' })).toBeTruthy();
  expect(screen.queryByText(/Something went wrong/)).toBeNull();
  expect(screen.queryByText(/"seq"/)).toBeNull();
  spy.mockRestore();
});
