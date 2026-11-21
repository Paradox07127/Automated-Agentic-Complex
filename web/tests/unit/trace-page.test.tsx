// The developer 追踪 page (turn list, 轮次详情, 今日用量), the chat page's 10-minute track only in 开发者模式.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatPage } from '../../src/pages/chat/Page';
import { DiagPage } from '../../src/pages/diag/Page';
import { TracePage } from '../../src/pages/trace/Page';
import { setDevMode } from '../../src/shell/devMode';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mount(component: RouteComponent, search: string) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const TRACK = /^最近 10 分钟前台与旁路/;

describe(' 追踪 page', () => {
  it('/trace?turn=<id> shows that turn with its judge probabilities and cost, and today’s usage', async () => {
    mount(TracePage, '&demo=full&turn=tr7');
    expect(await screen.findByRole('list', { name: '判断：发言 0.82，等待 0.12，沉默 0.06，选中发言' })).toBeTruthy();
    expect(screen.getByText('$0.013')).toBeTruthy();
    expect(screen.getByRole('row', { name: /14:26/, selected: true })).toBeTruthy();
    const usage = await screen.findByRole('region', { name: '今日用量' });
    await waitFor(() => expect(usage.textContent).toMatch(/\$\d+\.\d{2}/));
  });
});

describe(' chat page developer entries', () => {
  it('draws the 最近 10 分钟 track only in 开发者模式', async () => {
    setDevMode(true);
    const on = await (mount(ChatPage, '&demo=full'), screen.findByRole('region', { name: '消息' }));
    expect(await within(on).findByRole('group', { name: TRACK })).toBeTruthy();
    cleanup();
    setDevMode(false);
    mount(ChatPage, '&demo=full');
    const off = await screen.findByRole('region', { name: '消息' });
    await within(off).findByText('按项目分组，不要按日期。');
    expect(within(off).queryByRole('group', { name: TRACK })).toBeNull();
  });

  it('轮次详情 opens that turn on /trace in normal mode', async () => {
    setDevMode(false);
    const router = mount(ChatPage, '&demo=full&turn=tr7');
    const col = await screen.findByRole('complementary', { name: '轮次详情' });
    fireEvent.click(await within(col).findByRole('button', { name: '完整运行记录 ↗' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/trace'));
    expect(router.state.location.search).toMatchObject({ turn: 'tr7' });
  });
});

describe(' 诊断 keeps its usage card', () => {
  it('still has diag-usage with 今日用量', async () => {
    mount(DiagPage, '');
    const usage = await waitFor(() => {
      const el = document.querySelector('[data-nav-target="diag-usage"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(usage.textContent).toContain('今日用量');
  });
});
