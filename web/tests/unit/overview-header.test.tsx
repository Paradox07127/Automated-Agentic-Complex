// 工业简报's header: the top bar says 已连接, so the page's own pip speaks only while reading or after a failed refresh.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewPage } from '../../src/pages/overview/Page';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  pluginsReset();
  pluginsOn('daily_brief');
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
});

function mount(search: string) {
  const root = createRootRoute({ component: OverviewPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('工业简报 pip', () => {
  it('shows nothing once read', async () => {
    mount('');
    await waitFor(() => expect(document.body.textContent).toMatch(/对话 \d/), { timeout: 3000 });
    expect(screen.queryByText('已连接')).toBeNull();
  });

  it('says 读取中 while reading and 刷新失败 after a failed refresh', async () => {
    mount('&state=loading');
    expect(await screen.findByText('读取中')).toBeTruthy();
    cleanup();
    mount('&state=error');
    expect(await screen.findByText('刷新失败', undefined, { timeout: 3000 })).toBeTruthy();
  });
});
