// 每日简报: a readout opens what it counts — 出错 lists the day's errors in a sheet, a category opens its page or tab.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { WireBriefError } from '../../src/domain/wire';
import { NOW } from '../../src/mock/fixtures';
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

const sec = (h: number, m: number) => new Date(NOW).setHours(h, m, 0, 0) / 1000;
const NO_IDS = { task_id: null, run_id: null, turn_id: null, trace_id: null, session_id: null };
/** Today's `/brief/day` errors, oldest first as agentd sends them. */
const ERRORS: WireBriefError[] = [
  { ...NO_IDS, kind: 'task', id: 't-led-1', at: sec(9, 5), title: '整理 11 月发票', reason: 'verify_failed', task_id: 't-led-1', run_id: 'run-1' },
  { ...NO_IDS, kind: 'turn', id: 'turn-9', at: sec(11, 30), title: null, reason: 'timeout', turn_id: 'turn-9', trace_id: 'trace-9' },
  { ...NO_IDS, kind: 'session', id: 'claude:s1', at: sec(12, 40), title: null, reason: 'error', session_id: 'claude:s1' },
  { ...NO_IDS, kind: 'run', id: 'run-2', at: sec(13, 10), title: '下载资源索引', reason: 'network', task_id: 't-led-2', run_id: 'run-2', trace_id: 'trace-2' },
];

/** The mock day answers with `errors` and the 出错 count that goes with them. */
function withErrors(errors: WireBriefError[]) {
  const agentd = getBridge().agentd;
  const request = agentd.request.bind(agentd);
  vi.spyOn(agentd, 'request').mockImplementation(async (method, path, body) => {
    const r = await request<BriefDay>(method, path, body);
    if (!path.startsWith('/brief/day') || !r.body) return r as never;
    return { ...r, body: { ...r.body, items: { ...r.body.items, err: { ...r.body.items.err, today: errors.length } }, errors } } as never;
  });
}

describe('总览 readouts open what they count', () => {
  it('出错 lists exactly the day’s /brief/day errors, newest first; each opens its task or turn, a run also its trace', async () => {
    withErrors(ERRORS);
    mount();
    fireEvent.click((await band()).getByRole('button', { name: /^出错 4，/ }));
    const sheet = await screen.findByRole('dialog', { name: '出错' });
    await waitFor(() => expect(sheet.querySelectorAll('[data-err]')).toHaveLength(4));
    const rows = [...sheet.querySelectorAll<HTMLElement>('[data-err]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      '下载资源索引13:10 │ 角色运行 │ network',
      '编码会话出错12:40 │ 编码会话 │ error',
      '一轮对话没有完成11:30 │ 对话 │ timeout',
      '整理 11 月发票09:05 │ 任务 │ verify_failed',
    ]);
    expect(rows[1]!.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(rows[3]!);
    expect(window.location.hash).toMatch(/^#\/tasks\?sel=task(:|%3A)t-led-1(&|$)/);
    fireEvent.click(rows[2]!);
    expect(window.location.hash).toBe('#/diag?tab=turns&turn=trace-9');
    fireEvent.click(rows[0]!);
    expect(window.location.hash).toMatch(/^#\/tasks\?sel=task(:|%3A)t-led-2(&|$)/);
    fireEvent.click(within(sheet).getByRole('button', { name: '对话轮次 ›' }));
    expect(window.location.hash).toBe('#/diag?tab=turns&turn=trace-2');
  });

  it('a day without errors says so', async () => {
    withErrors([]);
    mount();
    fireEvent.click((await band()).getByRole('button', { name: /^出错 0，/ }));
    const sheet = await screen.findByRole('dialog', { name: '出错' });
    expect(await within(sheet).findByText('今天没有出错')).toBeTruthy();
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
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).tab).toBe('char'));
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
