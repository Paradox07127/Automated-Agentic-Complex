// A library without characters: the character page is one 导入角色 button, and an import reads the roster again.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

it('shows only the import button and reads the roster again after an import', async () => {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  const list = vi.spyOn(bridge.character, 'list').mockResolvedValue([]);
  const importPackage = vi.spyOn(bridge.character, 'importPackage').mockResolvedValue({ ok: true });
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const region = await screen.findByRole('region', { name: '当前无可用角色' });
  const button = within(region).getByRole('button', { name: '导入角色' });
  expect(region.textContent).toBe('导入角色');
  expect(screen.queryByText(/读取角色目录失败/)).toBeNull();
  const reads = list.mock.calls.length;
  await act(async () => void fireEvent.click(button));
  expect(importPackage).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
});
