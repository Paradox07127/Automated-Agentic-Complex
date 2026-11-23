// 每日简报: a readout opens what it counts — 出错 lists the day's errors in a sheet, a category opens its page or tab.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DEFAULT_PINS, type BriefDay } from '../../src/pages/overview/briefDay';
import { DetailTab } from '../../src/pages/overview/DetailTab';
import { OverviewPage } from '../../src/pages/overview/Page';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  pluginsOn();
  Element.prototype.scrollIntoView = vi.fn();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
  sessionStorage.clear();
});

function mount() {
  const root = createRootRoute({ component: OverviewPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const band = async () => within(await screen.findByRole('list', { name: '读数' }, { timeout: 3000 }));

describe('总览 readouts open what they count', () => {
  it('出错 opens a sheet of the day’s errors; a failed task opens its task, a failed turn opens 诊断 › 对话轮次', async () => {
    mount();
    fireEvent.click((await band()).getByRole('button', { name: /^出错 \d+，/ }));
    const sheet = await screen.findByRole('dialog', { name: '出错' });
    const task = await within(sheet).findByRole('button', { name: /^下载资源索引/ }, { timeout: 3000 });
    expect(task.textContent).toMatch(/\d{2}:\d{2}/);
    fireEvent.click(task);
    expect(window.location.hash).toMatch(/^#\/tasks\?sel=/);
    const turn = await within(sheet).findByRole('button', { name: /^一轮对话.* │ 对话/ }, { timeout: 3000 });
    fireEvent.click(turn);
    expect(window.location.hash).toMatch(/^#\/diag\?tab=turns&turn=/);
  });

  it('任务完成 opens the tasks page on 已完成', async () => {
    mount();
    fireEvent.click((await band()).getByRole('button', { name: /^任务完成 \d+，/ }));
    expect(window.location.hash).toMatch(/^#\/tasks\?tab=done/);
  });

  it('模型花费 opens 诊断 › 链路 at the model calls', async () => {
    mount();
    fireEvent.click((await band()).getByRole('button', { name: /^模型花费 / }));
    expect(window.location.hash).toMatch(/^#\/diag\?tab=flow&item=usage/);
  });

  it('主动发言 opens the brief’s character tab', async () => {
    const router = mount();
    fireEvent.click((await band()).getByRole('button', { name: /^主动发言 \d+ 次，/ }));
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).tab).toBe('her'));
  });
});

describe('明细 rows open what they count', () => {
  it('an item name opens it through links; one without a list stays text', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const day = (await bridge.agentd.request<BriefDay>('GET', '/brief/day?date=2026-11-20')).body!;
    const err = vi.fn();
    render(<DetailTab day={day} pins={DEFAULT_PINS} onPins={() => {}} go={() => {}} links={{ err: { open: err, to: '查看出错列表' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /^出错 .*，查看出错列表$/ }));
    expect(err).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^截图 / })).toBeNull();
  });
});
