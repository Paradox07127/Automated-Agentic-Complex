// The developer 运行记录 page (turn list, 经过, 日志), the chat page's 10-minute track only in 开发者模式.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatPage } from '../../src/pages/chat/Page';
import { DiagPage } from '../../src/pages/diag/Page';
import { TracePage } from '../../src/pages/trace/Page';
import { setDevMode } from '../../src/shell/devMode';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

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

describe(' 运行记录 page', () => {
  it('/trace?turn=<id> picks that row and shows its 经过 with the cost; the 判断 step opens to its probabilities', async () => {
    mount(TracePage, '&demo=full&turn=tr7');
    const detail = await screen.findByRole('region', { name: '这一轮' });
    await waitFor(() => expect(detail.textContent).toContain('$0.013'));
    expect(screen.getByRole('option', { selected: true }).getAttribute('data-turn')).toBe('tr7');
    const steps = within(detail).getByRole('region', { name: '经过' });
    fireEvent.click(steps.querySelector<HTMLElement>('[data-step="judge"]')!);
    expect((await within(steps).findByRole('list', { name: '判断' })).textContent).toContain('0.82');
    // The usage block and 刷新记录 are gone: the brief has the day's spend and the lamp says the list is live.
    expect(screen.queryByRole('region', { name: '今日用量' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新记录' })).toBeNull();
  });

  it('日志: lines from the bridge with debug off by default; 看日志 on a turn narrows to its time', async () => {
    const router = mount(TracePage, '&tab=logs');
    const log = await screen.findByRole('log', { name: '日志行' });
    await waitFor(() => expect(log.textContent).toContain('ritual settle failed'));
    expect(log.textContent).not.toContain('fps=60');
    fireEvent.click(screen.getByRole('button', { name: /^调试/ }));
    await waitFor(() => expect(log.textContent).toContain('fps=60'));
    fireEvent.click(screen.getByRole('tab', { name: '轮次' }));
    await screen.findByRole('region', { name: '经过' });
    fireEvent.click(screen.getByRole('button', { name: '看日志' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'logs' }));
    expect(await screen.findByRole('button', { name: /^只看第 \d+ 轮前后/ })).toBeTruthy();
  });

  it('/trace?tab=logs&src=agentd shows only 后台服务 lines', async () => {
    mount(TracePage, '&tab=logs&src=agentd');
    const log = await screen.findByRole('log', { name: '日志行' });
    await waitFor(() => expect(log.textContent).toContain('ritual settle failed'));
    expect([...log.querySelectorAll('[data-key]')].every((l) => l.getAttribute('data-key')!.startsWith('agentd:'))).toBe(true);
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
