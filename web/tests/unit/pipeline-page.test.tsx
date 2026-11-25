// 记忆页的管线页签（开发者）：观察 → 理解 → 整理 → 记忆库四个工位卡排成产线，选中一个看它的详情；它不再是单独的页面。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
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
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = '';
});

function mountAt(component: RouteComponent, search = '', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

type Request = ReturnType<typeof getBridge>['agentd']['request'];
/** Answers through `answer` where it returns a response, else through the fake bridge. */
function serve(answer: (method: string, path: string) => Awaited<ReturnType<Request>> | undefined) {
  const agentd = getBridge().agentd;
  const real = agentd.request.bind(agentd);
  return vi.spyOn(agentd, 'request').mockImplementation(((method, path, body) => {
    const r = answer(method, path);
    return r ? Promise.resolve(r) : real(method, path, body);
  }) as Request);
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
    expect(await screen.findByRole('region', { name: '当前推断' }, T)).toBeTruthy();
    expect(screen.getByRole('region', { name: '近期记录' })).toBeTruthy();
  });

  it('记忆库 lists the sources and offers to confirm the candidates', async () => {
    mountAt(PipelineView, '&station=store');
    const src = await screen.findByRole('group', { name: '按来源' }, T);
    expect(within(src).getByText('陈述')).toBeTruthy();
    expect(screen.getByRole('img', { name: /^14 天新增/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^处理 \d+ 条待确认/ })).toBeTruthy();
  });

  it('with the backend gone it says so and every station reads 读不到', async () => {
    mountAt(PipelineView, '&state=error');
    expect((await screen.findAllByText(/后台服务已断开/, {}, T)).length).toBeGreaterThan(0);
    for (const tab of screen.getAllByRole('tab')) expect(tab.getAttribute('aria-label')).toContain('读取失败');
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

  it('理解 asks /summary/runs for observation_interpret runs, which agentd leaves out by default', async () => {
    const run = (id: string, kind: string) => ({ run_id: id, kind, started_at: '2026-10-29T14:02:05+08:00', span_start: null, span_end: null, outcome: 'failed', error: '模型超时', attempt: 1, duration_ms: 1200, backend: 'codex', model: 'gpt-5-mini', episode_id: null, reasons: [] });
    serve((method, path) => {
      if (method !== 'GET' || !path.startsWith('/summary/runs')) return undefined;
      const kinds = new URLSearchParams(path.split('?')[1]).get('kinds')?.split(',') ?? ['memory_extract'];
      const runs = [run('oi-x', 'observation_interpret'), run('mr-x', 'memory_extract')].filter((r) => kinds.includes(r.kind));
      return { status: 200, body: { date: '2026-10-29', runs } };
    });
    mountAt(PipelineView, '&station=interp');
    const log = await screen.findByRole('region', { name: '近期记录' }, T);
    expect(await within(log).findByText('模型超时', {}, T)).toBeTruthy();
    expect(within(log).getAllByText('失败').length).toBe(1);
  });

  it('a batch whose detail was redacted meanwhile no longer shows what it wrote', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mountAt(PipelineView, '', client);
    const table = await screen.findByRole('group', { name: '整理记录' }, T);
    await waitFor(() => expect(table.textContent).toMatch(/\+\d+新增/), T);
    cleanup();
    let redacted = 0;
    const real = getBridge().agentd.request.bind(getBridge().agentd);
    vi.spyOn(getBridge().agentd, 'request').mockImplementation((async (method: string, path: string, body?: unknown) => {
      const r = await real(method as 'GET', path, body);
      if (method !== 'GET' || !path.startsWith('/memory/runs')) return r;
      const b = r.body as { runs?: Array<Record<string, unknown>> } & Record<string, unknown>;
      if (b.runs) return { ...r, body: { runs: b.runs.map((x) => ({ ...x, redacted_reason: 'memory_changed' })) } };
      redacted += 1;
      return { ...r, body: { ...b, detail: null, redacted_reason: 'memory_changed' } };
    }) as Request);
    mountAt(PipelineView, '', client);
    const again = await screen.findByRole('group', { name: '整理记录' }, T);
    await waitFor(() => {
      expect(again.textContent).not.toMatch(/\+\d+新增/);
      expect(redacted).toBeGreaterThan(0);
    }, T);
  });

  it('a jump to a station lands on the 管线 tab of 记忆', () => {
    expect(navRoute({ page: 'memory', view: 'pipeline', station: 'mem', run: 'mrun-00' })).toBe('/memory?view=pipeline&station=mem&run=mrun-00');
  });
});
