// Shell: ⌘K opens and closes the palette, whose code loads apart from the shell's.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { Layout } from '../../src/shell/Layout';
import { stubMatchMedia } from './mediaStub';

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

it('opens the palette on ⌘K and closes it on the next', async () => {
  stubMatchMedia();
  const root = createRootRoute({ component: Layout });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: '主导航' });
  expect(screen.queryByRole('listbox')).toBeNull();
  act(() => void fireEvent.keyDown(window, { key: 'k', metaKey: true }));
  expect(await screen.findByRole('listbox')).toBeTruthy();
  act(() => void fireEvent.keyDown(window, { key: 'k', metaKey: true }));
  expect(screen.queryByRole('listbox')).toBeNull();
});
