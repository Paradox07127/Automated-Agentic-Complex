// 记忆页的管线页签（开发者）：观察 → 理解 → 整理 → 记忆库四个工位卡排成产线，选中一个看它的详情；它不再是单独的页面。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineView } from '../../src/pages/pipeline/Page';
import { CommandBar } from '../../src/shell/CommandBar';
import { setDevMode } from '../../src/shell/devMode';
import { navRoute } from '../../src/shell/nav';
import { pageRoutes } from '../../src/shell/registry';
import { stubMatchMedia } from './mediaStub';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
const T = { timeout: 3000 };

describe('管线页签', () => {
  it('draws the four stations in a line, 整理 picked, its batches one row each', async () => {
    mountAt(PipelineView);
    const line = await screen.findByRole('tablist', { name: '工位' }, T);
    expect(within(line).getAllByRole('tab').map((t) => t.getAttribute('aria-label')?.split('：')[0])).toEqual(['观察', '理解', '整理', '记忆库']);
    expect(within(line).getByRole('tab', { selected: true }).getAttribute('aria-label')).toMatch(/^整理：/);
    const table = await screen.findByRole('group', { name: '整理记录' }, T);
    expect((await within(table).findAllByText('后台整理', {}, T)).length).toBeGreaterThan(0);
    expect(within(table).getAllByText('对话中').length).toBeGreaterThan(0);
  });

  it('a batch row opens to what it wrote, and 生成记录 opens the sheet', async () => {
    mountAt(PipelineView);
    const table = await screen.findByRole('group', { name: '整理记录' }, T);
    const rows = await within(table).findAllByRole('button', { expanded: false }, T);
    fireEvent.click(rows[0]!);
    expect(await within(table).findByText('按项目分组', {}, T)).toBeTruthy();
    fireEvent.click(within(table).getAllByRole('button', { name: '生成记录' })[0]!);
    expect(await screen.findByRole('dialog', { name: '生成记录' }, T)).toBeTruthy();
  });

  it('?run= picks 整理 and opens that batch’s generation record', async () => {
    mountAt(PipelineView, '&station=obs&run=mrun-00');
    expect(await screen.findByRole('dialog', { name: '生成记录' }, T)).toBeTruthy();
  });

  it('?run= opens that batch’s row to what it wrote', async () => {
    mountAt(PipelineView, '&run=mrun-00');
    const sheet = await screen.findByRole('dialog', { name: '生成记录' }, T);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '生成记录' })).toBeNull(), T);
    const table = await screen.findByRole('group', { name: '整理记录' }, T);
    expect(await within(table).findByText(/按项目分组/, {}, T)).toBeTruthy();
    expect(within(table).getAllByRole('button', { expanded: true })).toHaveLength(1);
  });

  it('below 1100 px the station cards and the readouts go compact; wide they stay as they are', async () => {
    const media = stubMatchMedia(new Set(['(max-width: 1099px)']));
    mountAt(PipelineView);
    const line = await screen.findByRole('tablist', { name: '工位' }, T);
    const cards = within(line).getAllByRole('tab');
    expect(cards.every((c) => c.hasAttribute('data-compact'))).toBe(true);
    await waitFor(() => expect(document.querySelectorAll('[data-stub="ReadTick"]').length).toBeGreaterThan(0), T);
    expect([...document.querySelectorAll('[data-stub="ReadTick"]')].every((t) => t.hasAttribute('data-inline'))).toBe(true);
    media.set('(max-width: 1099px)', false);
    await waitFor(() => expect(within(line).getAllByRole('tab').some((c) => c.hasAttribute('data-compact'))).toBe(false));
    expect([...document.querySelectorAll('[data-stub="ReadTick"]')].some((t) => t.hasAttribute('data-inline'))).toBe(false);
  });

  it('?station= picks the station; → moves along the line, Q / E are left to the page tabs', async () => {
    mountAt(PipelineView, '&station=obs');
    expect(await screen.findByRole('region', { name: '最近请求' }, T)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'e' });
    expect(screen.getByRole('region', { name: '最近请求' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(await screen.findByRole('region', { name: '她现在的理解' }, T)).toBeTruthy();
    expect(screen.getByRole('region', { name: '最近理解' })).toBeTruthy();
  });

  it('记忆库 lists the sources and offers to confirm the candidates', async () => {
    mountAt(PipelineView, '&station=store');
    const src = await screen.findByRole('group', { name: '按来源' }, T);
    expect(within(src).getByText('陈述')).toBeTruthy();
    expect(screen.getByRole('img', { name: /^14 天新增/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^去确认 \d+ 条/ })).toBeTruthy();
  });

  it('with the backend gone it says so and every station reads 读不到', async () => {
    mountAt(PipelineView, '&state=error');
    expect((await screen.findAllByText(/后台已断开/, {}, T)).length).toBeGreaterThan(0);
    for (const tab of screen.getAllByRole('tab')) expect(tab.getAttribute('aria-label')).toContain('读不到');
  });

  it('is no page of its own: no /pipeline route and nothing in the command bar page menu', async () => {
    setDevMode(true);
    expect(pageRoutes.map((r) => r.id)).not.toContain('pipeline');
    stubMatchMedia();
    mountAt(() => <CommandBar routes={pageRoutes} activeId="overview" title="每日简报" tabsRef={noop} rightRef={noop} actionRef={noop} />);
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    fireEvent.click(within(nav).getByRole('button', { name: '每日简报' }));
    expect(screen.queryByRole('menuitem', { name: /记忆管线/ })).toBeNull();
  });

  it('a jump to a station lands on the 管线 tab of 记忆', () => {
    expect(navRoute({ page: 'memory', view: 'pipeline', station: 'mem', run: 'mrun-00' })).toBe('/memory?view=pipeline&station=mem&run=mrun-00');
  });
});
