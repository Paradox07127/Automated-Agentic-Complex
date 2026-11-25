// The developer 运行记录 page (turn list, 经过, 日志); the chat page no longer shows the turn trace.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { isoToMs } from '../../src/domain';
import { TRACE_TURNS } from '../../src/mock/diag';
import { CHAT_DEMO } from '../../src/mock/fixtures/chatDemo';
import { DiagPage } from '../../src/pages/diag/Page';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.agenticComplex;
});

function mount(component: RouteComponent, search: string) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${/tab=/.test(search) ? '' : '&tab=turns'}${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe(' 运行记录 page', () => {
  it('/trace?turn=<id> picks that row and shows its 经过 with the cost; the 判断 step opens to its probabilities', async () => {
    mount(DiagPage, '&demo=full&turn=tr7');
    const detail = await screen.findByRole('region', { name: '本轮详情' });
    await waitFor(() => expect(detail.textContent).toContain('$0.013'));
    expect(screen.getByRole('option', { selected: true }).getAttribute('data-turn')).toBe('tr7');
    const steps = within(detail).getByRole('region', { name: '执行轨迹' });
    fireEvent.click(steps.querySelector<HTMLElement>('[data-step="judge"]')!);
    expect((await within(steps).findByRole('list', { name: '判断' })).textContent).toContain('0.82');
    // The usage block and 刷新记录 are gone: the brief has the day's spend and the lamp says the list is live.
    expect(screen.queryByRole('region', { name: '今日用量' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新记录' })).toBeNull();
  });

  it('/trace?turn=<trace_id> picks the listed row whose trace id it is', async () => {
    mount(DiagPage, '&demo=full&turn=trace-tr7');
    await waitFor(() => expect(screen.getByRole('option', { selected: true }).getAttribute('data-turn')).toBe('tr7'));
    expect(await within(screen.getByRole('region', { name: '本轮详情' })).findByRole('region', { name: '执行轨迹' })).toBeTruthy();
  });

  it('/trace?turn=<trace_id> outside the recent list reads that turn by its trace id', async () => {
    const old = TRACE_TURNS.find((r) => isoToMs(r.started_at) < Date.now() - 2 * 86_400_000)!;
    // The store knows this turn only by its trace id: by turn_id it finds nothing.
    const route = { method: 'GET' as const, path: '/trace/turns', handler: ({ query }: { query: URLSearchParams }) => ({ status: 200, body: { turns: query.get('trace_id') === old.trace_id ? [{ ...old, turn_id: 'turn-old' }] : [] } }) };
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true, routes: [route] });
    mount(DiagPage, `&turn=${old.trace_id}`);
    const detail = await screen.findByRole('region', { name: '本轮详情' });
    expect(await within(detail).findByRole('region', { name: '执行轨迹' })).toBeTruthy();
    expect(detail.textContent).toContain(`trace ${old.trace_id.slice(0, 8)}`);
  });

  it('/trace?at=<ms> picks the first turn at or after that time', async () => {
    const day = [...CHAT_DEMO.full.rows].sort((a, b) => isoToMs(b.started_at) - isoToMs(a.started_at));
    const mid = day[Math.floor(day.length / 2)]!;
    const at = isoToMs(mid.started_at) - 1;
    const want = day.filter((r) => isoToMs(r.started_at) >= at).sort((a, b) => isoToMs(a.started_at) - isoToMs(b.started_at))[0]!;
    expect(want.turn_id).not.toBe(day[0]!.turn_id);
    mount(DiagPage, `&demo=full&at=${at}`);
    await waitFor(() => expect(screen.getByRole('option', { selected: true }).getAttribute('data-turn')).toBe(want.turn_id));
  });

  it('日志: lines from the bridge with debug off by default; 看日志 on a turn narrows to its time', async () => {
    mount(DiagPage, '&tab=logs');
    const log = await screen.findByRole('log', { name: '日志行' });
    await waitFor(() => expect(log.textContent).toContain('ritual settle failed'));
    expect(log.textContent).not.toContain('fps=60');
    fireEvent.click(screen.getByRole('button', { name: '级别 3/4' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '调试' }));
    await waitFor(() => expect(log.textContent).toContain('fps=60'));
    // The tabs go through the app's navigation; open 对话轮次 by its URL instead.
    cleanup();
    const turns = mount(DiagPage, '&tab=turns');
    await screen.findByRole('region', { name: '执行轨迹' });
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    await waitFor(() => expect(turns.state.location.search).toMatchObject({ tab: 'logs' }));
    expect(await screen.findByRole('button', { name: /^仅显示第 \d+ 轮前后/ })).toBeTruthy();
  });

  it('/trace?tab=logs&src=agentd shows only 后台服务 lines', async () => {
    mount(DiagPage, '&tab=logs&src=agentd');
    const log = await screen.findByRole('log', { name: '日志行' });
    await waitFor(() => expect(log.textContent).toContain('ritual settle failed'));
    expect([...log.querySelectorAll('[data-key]')].every((l) => l.getAttribute('data-key')!.startsWith('agentd:'))).toBe(true);
  });
});

describe(' 诊断 keeps its usage card', () => {
  it('has diag-usage with 模型调用 on its 管道 tab', async () => {
    mount(DiagPage, '&tab=flow');
    const usage = await waitFor(() => {
      const el = document.querySelector('[data-nav-target="diag-usage"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(usage.textContent).toContain('模型调用');
  });
});
