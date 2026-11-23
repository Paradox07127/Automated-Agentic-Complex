// 今天：sel 跳到任务页、当前任务（回退：按目标或项目分组）、开发者模式关闭时不露内部读数、待处理落点。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A1, T1 } from '../../src/mock/fixtures/ids';
import { OverviewPage } from '../../src/pages/overview/Page';
import { setDevMode } from '../../src/shell/devMode';
import { useLandingFocus } from '../../src/shell/nav';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  // 进行中 and 派发任务 need 编码会话 and 个人代理.
  pluginsOn();
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  localStorage.clear();
  pluginsReset();
});

function Landing({ focus }: { focus: string | null }) {
  useLandingFocus(focus, '', true);
  return null;
}

function mount(search = '') {
  const focus = new URLSearchParams(search).get('focus');
  const root = createRootRoute({
    component: () => (
      <>
        <OverviewPage />
        <Landing focus={focus} />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('今天', () => {
  it('sel and create open on the tasks page, in place of this page in history', async () => {
    const router = mount(`&sel=${T1}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'), { timeout: 3000 });
    expect(new URLSearchParams(router.state.location.searchStr).get('sel')).toBe(T1);
    expect(router.history.length).toBe(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    const again = mount('&create=role');
    await waitFor(() => expect(again.state.location.pathname).toBe('/tasks'), { timeout: 3000 });
    expect(new URLSearchParams(again.state.location.searchStr).get('create')).toBe('role');
  });

  it('a jump to another page does not open its sel here while this page is still shown', async () => {
    const router = mount();
    await screen.findByRole('region', { name: '待处理' }, { timeout: 3000 });
    await act(() => router.history.push(`/tasks?still=1&tab=all&sel=${encodeURIComponent(T1)}`));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows no inferred task grid and no task records: the tasks page has them', async () => {
    mount('&demo=absent');
    await screen.findByRole('region', { name: '待处理' });
    expect(screen.queryByRole('region', { name: '当前任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '任务记录' })).toBeNull();
  });

  it('focus=item-<id> with a sel stays here', async () => {
    const router = mount(`&sel=${A1}&focus=item-${A1}`);
    await screen.findByRole('region', { name: '待处理' }, { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(router.state.location.pathname).toBe('/');
  });

  it('with 开发者模式 off there is no role band and no screenshot readout', async () => {
    setDevMode(false);
    mount();
    await screen.findAllByText(/个编码会话/, undefined, { timeout: 3000 });
    expect(document.querySelector('[data-band]')).toBeNull();
    expect(screen.queryByRole('link', { name: /前往角色页/ })).toBeNull();
    expect(document.body.textContent).not.toContain('截图');
  });

  it('without the role band, a paused observation still says so with 现在恢复', async () => {
    mount('&demo=pause');
    await waitFor(() => expect(screen.getAllByRole('status').some((s) => s.textContent?.startsWith('观察暂停'))).toBe(true), { timeout: 3000 });
    const pause = screen.getAllByRole('status').find((s) => s.textContent?.startsWith('观察暂停'))!;
    expect(within(pause).getByRole('button', { name: '现在恢复' })).toBeTruthy();
  });

  it('heads the day with 今日一句 and the readouts; 待处理 leads the left column, 进行中 the right', async () => {
    mount();
    const line = await screen.findByRole('region', { name: '今日一句' }, { timeout: 3000 });
    await waitFor(() => expect(line.textContent).toMatch(/^今日一句今天 \d+ 个编码会话/), { timeout: 3000 });
    // 聊了什么 and 进行中 count those; the line does not say them again.
    expect(line.textContent).not.toMatch(/段对话|进行中|待批准/);
    expect(within(screen.getByRole('list', { name: '读数' })).getAllByRole('listitem').length).toBeGreaterThan(0);
    const need = screen.getByRole('region', { name: '待处理' });
    const run = screen.getByRole('region', { name: '进行中' });
    expect(need.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(need.parentElement?.parentElement).not.toBe(run.parentElement?.parentElement);
    expect(screen.getByRole('toolbar', { name: '常用操作' })).toBeTruthy();
  });

  it('the page has one name, 每日简报, and no 派发任务: the action band draws its buttons alike', async () => {
    mount('&demo=sparse');
    await screen.findByRole('tablist', { name: '简报页签' }, { timeout: 3000 });
    await screen.findByText('当前没有编码会话');
    expect(document.body.textContent).not.toContain('今日简报');
    expect(document.body.textContent).not.toContain('工业简报');
    const band = screen.getByRole('toolbar', { name: '常用操作' });
    expect(new Set(within(band).getAllByRole('button').map((b) => b.getAttribute('data-variant')))).toEqual(new Set(['ghost']));
    expect(screen.queryAllByRole('button', { name: /派发/ })).toEqual([]);
  });

  it('免打扰 has one name: its items are 30 分钟, 1 小时, 到明早 7 点 and 开会, with no 安静', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '免打扰' }));
    const menu = await screen.findByRole('menu', { name: '免打扰' });
    const items = [...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent);
    expect(items.slice(0, 4)).toEqual(['30 分钟', '1 小时', '到明早 7 点', '开会']);
    expect(menu.textContent).not.toContain('安静');
  });

  it('focus=item-<id> lands on the pending item', async () => {
    mount(`&focus=item-${A1}`);
    await waitFor(() => expect(document.querySelector(`[data-nav-target="item-${A1}"]`)?.hasAttribute('data-nav-hl')).toBe(true), { timeout: 3000 });
  });
});
