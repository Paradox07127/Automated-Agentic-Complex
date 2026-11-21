// 管线页（开发者）放记忆来源、整理批次、生成记录、截图配额和「现在」；侧栏只在开发者模式列出它。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelinePage } from '../../src/pages/pipeline/Page';
import { CommandBar } from '../../src/shell/CommandBar';
import { setDevMode } from '../../src/shell/devMode';
import { pageRoutes } from '../../src/shell/registry';
import { createAppRouter } from '../../src/shell/router';
import { stubMatchMedia } from './mediaStub';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '';
});

function mountAt(component: RouteComponent, search = '') {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const noop = () => {};

describe('管线页', () => {
  it('draws the memory sources and the consolidation batches', async () => {
    mountAt(PipelinePage);
    const sources = await screen.findByRole('region', { name: '记忆概况' }, { timeout: 3000 });
    expect(sources.textContent).toContain('按来源');
    const changes = screen.getByRole('region', { name: '最近变化' });
    expect((await within(changes).findAllByRole('button', { name: /整理批次/ }, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(await screen.findByRole('region', { name: '截图配额' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '现在' })).toBeTruthy();
  });

  it('a batch opens its generation record', async () => {
    mountAt(PipelinePage, '&run=mrun-00');
    expect(await screen.findByRole('dialog', { name: '记忆生成记录' }, { timeout: 3000 })).toBeTruthy();
  });

  it('stays out of the command bar with developer mode off, and its URL still opens', async () => {
    setDevMode(false);
    stubMatchMedia();
    mountAt(() => <CommandBar routes={pageRoutes} activeId="overview" title="工业简报" tabsRef={noop} rightRef={noop} actionRef={noop} />);
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    fireEvent.click(within(nav).getByRole('button', { name: '工业简报' }));
    expect(screen.queryByRole('menuitem', { name: /管线/ })).toBeNull();
    const router = createAppRouter();
    router.history.push('/pipeline');
    await router.load();
    expect(router.state.location.pathname).toBe('/pipeline');
    expect(router.state.matches.at(-1)?.routeId).toBe('/pipeline');
  });

  it('lists 管线 in the command bar page menu with developer mode on', async () => {
    setDevMode(true);
    stubMatchMedia();
    mountAt(() => <CommandBar routes={pageRoutes} activeId="overview" title="工业简报" tabsRef={noop} rightRef={noop} actionRef={noop} />);
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    fireEvent.click(within(nav).getByRole('button', { name: '工业简报' }));
    expect(screen.getByRole('menuitem', { name: /管线/ })).toBeTruthy();
  });
});
