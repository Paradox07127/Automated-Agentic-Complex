// 记忆页只剩「项目」和「用户档案」（原名「关于你」）两个视图，共用一个搜索；来源占比和整理批次去了管线。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { MemoryTasksResponse } from '../../src/bridge/agentd-routes.generated';
import { MemoryPage } from '../../src/pages/memory/Page';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function mount(search = '') {
  window.location.hash = `#/memory?still=1${search}`;
  const root = createRootRoute({
    component: () => (
      <>
        <MemoryPage />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const facts = () => document.querySelectorAll('[data-fact]').length;
const projects = () => [...document.querySelectorAll('[data-project]')].map((r) => r.getAttribute('data-project'));
const tab = (name: string) => screen.findByRole('tab', { name }, { timeout: 3000 });

describe('记忆页', () => {
  it('has neither the source ratio nor the consolidation batches', async () => {
    mount('&view=about');
    await waitFor(() => expect(facts()).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByRole('region', { name: '记忆概况' })).toBeNull();
    expect(screen.queryByText(/来源占比/)).toBeNull();
    expect(screen.queryByRole('region', { name: '最近变化' })).toBeNull();
    expect(screen.queryByText(/整理批次/)).toBeNull();
  });

  it('用户档案 holds the asks and the fact list', async () => {
    mount('&view=about');
    expect((await tab('用户档案')).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findAllByRole('region', { name: /^待确认：/ }, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: '记忆' })).toBeTruthy();
    expect(facts()).toBeGreaterThan(0);
  });

  it('opens on 活动回顾 and on 用户档案 for a fact', async () => {
    mount();
    expect((await tab('活动回顾')).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(await screen.findByRole('button', { name: '查看 核对渲染测试结果' }));
    const detail = await screen.findByRole('dialog', { name: '核对渲染测试结果' });
    fireEvent.click(await within(detail).findByRole('button', { name: '查看证据 1' }));
    expect((await within(detail).findByText('本地重跑通过')).tagName).toBe('PRE');
    fireEvent.click(within(detail).getByRole('button', { name: '返回片段' }));
    await within(detail).findByRole('heading', { name: '原始证据' });
    fireEvent.click(within(detail).getAllByRole('button', { name: '关闭' }).at(-1)!);
    fireEvent.click(await tab('项目'));
    expect((await tab('项目')).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    cleanup();
    mount('&sel=x');
    expect((await tab('用户档案')).getAttribute('aria-selected')).toBe('true');
  });

  it('one search filters the facts and the projects', async () => {
    mount('&q=HostLink');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    fireEvent.click(await tab('其他事实与线索'));
    await waitFor(() => expect(facts()).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索记忆' }), { target: { value: '周报' } });
    await waitFor(() => expect(facts()).toBe(1));
    fireEvent.click(await tab('项目'));
    await waitFor(() => expect(projects()).toEqual([]));
    expect(screen.getByText('没有符合条件的项目')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '搜索记忆' }) as HTMLInputElement).value).toBe('周报');
  });

  it('a project opens its goal, progress and sessions; a session opens on 今天', async () => {
    mount('&view=projects');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    fireEvent.click(within(document.querySelector('[data-project="task-hostlink"]')!).getByRole('button'));
    const sheet = await screen.findByRole('dialog', { name: '修复 HostLink 断线重连' });
    expect(sheet.textContent).toContain('断线后自动恢复会话');
    expect(sheet.textContent).toContain('已定位心跳超时');
    fireEvent.click(await within(sheet).findByRole('button', { name: /验证断线恢复/ }));
    expect(window.location.hash).toContain('/overview?sel=ses-');
  });

  it('a project row has a decorative index, its project, date and session count; a lone project gets a sentence under it', async () => {
    mount('&view=projects');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    const row = document.querySelector('[data-project="task-hostlink"]') as HTMLElement;
    expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe('00.101');
    expect(row.textContent).toMatch(/修复 HostLink 断线重连Endfield\d{4}\.\d{2}\.\d{2}│会话 \d+$/);
    expect(within(row).getByRole('button').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: '进行中' })).toBeTruthy();
    expect(screen.getByText('后台整理新的编码会话后，其他项目会按状态列在这里')).toBeTruthy();
  });

  it('numbers project rows across the groups and drops the sentence once there are two', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation((async (method: 'GET', path: string, body?: unknown) => {
      const r = await read(method, path, body);
      if (!path.startsWith('/memory/tasks?')) return r;
      const { tasks } = r.body as MemoryTasksResponse;
      return { ...r, body: { ...(r.body as object), tasks: [...tasks, { ...tasks[0]!, id: 'task-parked', title: '整理周报模板', status: 'parked' }] } };
    }) as typeof bridge.agentd.request);
    mount('&view=projects');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink', 'task-parked']), { timeout: 3000 });
    const nos = projects().map((id) => document.querySelector(`[data-project="${id}"] [aria-hidden="true"]`)?.textContent);
    expect(nos).toEqual(['00.101', '00.102']);
    expect(screen.getByRole('group', { name: '搁置' })).toBeTruthy();
    expect(screen.queryByText('后台整理新的编码会话后，其他项目会按状态列在这里')).toBeNull();
  });

  it('hides 项目 when /memory/tasks is not there', async () => {
    mount('&view=projects&demo=absent');
    await waitFor(async () => expect((await tab('用户档案')).getAttribute('aria-selected')).toBe('true'), { timeout: 3000 });
    await waitFor(() => expect(facts()).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByRole('tab', { name: '项目' })).toBeNull();
  });
});
