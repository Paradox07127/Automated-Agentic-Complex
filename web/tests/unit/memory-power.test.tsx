// 记忆页的未通电态：项目 / 回顾 的插件关着时页签照常在，选中后整页已关闭并跳到那个开关；后台断开时档案整页未接入，按钮重启后台。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { MemoryPage } from '../../src/pages/memory/Page';
import { pluginsReset } from './plugins';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
  window.location.hash = '';
});

function mount(search = '') {
  window.location.hash = `#/memory?still=1${search}`;
  const root = createRootRoute({ component: MemoryPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const T = { timeout: 3000 };
const tab = (name: string) => screen.findByRole('tab', { name: new RegExp(`^${name}`) }, T);
const board = () => document.querySelector<HTMLElement>('[data-stub="PowerState"][data-mode="page"]');
const hashQuery = () => new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1));

describe('记忆页未通电', () => {
  it('keeps 项目 with 每日简报 off; it reads 已关闭 and leads to the switch', async () => {
    mount();
    fireEvent.click(await tab('项目'));
    const status = await screen.findByRole('status', { name: '每日简报' }, T);
    expect(within(status).getByText('已关闭')).toBeTruthy();
    expect(board()?.getAttribute('data-state')).toBe('off');
    fireEvent.click(within(status).getByRole('button', { name: /前往设置打开/ }));
    expect(window.location.hash).toMatch(/^#\/settings\?/);
    expect(hashQuery().get('group')).toBe('privacy');
    expect(hashQuery().get('item')).toBe('plugins.daily_brief');
  });

  it('keeps 回顾 with 屏幕感知 off; it reads 已关闭 and leads to the switch', async () => {
    mount('&view=activity');
    expect((await tab('回顾')).getAttribute('aria-selected')).toBe('true');
    const status = await screen.findByRole('status', { name: '屏幕感知' }, T);
    expect(within(status).getByText('已关闭')).toBeTruthy();
    fireEvent.click(within(status).getByRole('button', { name: /前往设置打开/ }));
    expect(hashQuery().get('group')).toBe('privacy');
    expect(hashQuery().get('item')).toBe('plugins.screen_awareness');
  });

  it('with the backend gone 档案 reads 未接入 instead of an error bar, and 重启后台 restarts agentd', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation(((method: 'GET', path: string) =>
      path.startsWith('/memory?') || path === '/memory'
        ? Promise.resolve({ status: 0, body: null, error: { code: 'offline', detail: 'agentd 没有响应' } })
        : read(method, path)) as typeof bridge.agentd.request);
    const restart = vi.spyOn(bridge.supervisor, 'restart');
    mount();
    const status = await screen.findByRole('status', { name: '后台服务' }, T);
    expect(within(status).getByText('未接入')).toBeTruthy();
    expect(board()?.getAttribute('data-state')).toBe('unlinked');
    expect(screen.queryByText(/没有读到记忆/)).toBeNull();
    fireEvent.click(within(status).getByRole('button', { name: /重启后台/ }));
    expect(restart).toHaveBeenCalledWith('agentd');
  });
});
