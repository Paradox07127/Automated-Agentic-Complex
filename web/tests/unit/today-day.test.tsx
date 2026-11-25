// 今天：今日时间线（合并、上限、来源图标、页内片段详情，在每日简报 › 时间）、今日一句，以及工作记忆（L1 / L3）优先、读不到时回退。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { at } from '../../src/mock/fixtures';
import { E1, E3 } from '../../src/mock/fixtures/ids';
import { WIRE_EPISODES } from '../../src/mock/fixtures/wire/memory';
import memoryDays from '../../../protocol/C6-agentd-api/fixtures/memory-days.json';
import memorySessions from '../../../protocol/C6-agentd-api/fixtures/memory-sessions.json';
import { DayTimeline } from '../../src/pages/overview/DayTimeline';
import { clock, dayOf } from '../../src/pages/overview/load';
import { OverviewPage } from '../../src/pages/overview/Page';
import { timelineFromDay } from '../../src/pages/overview/today';
import type { DayEpisode } from '../../src/pages/overview/loadBrief';
import { setPlugins } from '../../src/shell/plugins';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  pluginsOn();
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  localStorage.clear();
  pluginsReset();
});

function mount(search = '', Page = OverviewPage) {
  const root = createRootRoute({
    component: () => (
      <>
        <Page />
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

/** 每日简报 › 时间, under the hour chart. */
async function timeline(search = '') {
  mount(`&tab=tm${search}`);
  return screen.findByRole('region', { name: '今日时间线' }, { timeout: 3000 });
}
const L1 = memorySessions.sessions[0]!;
const L3 = memoryDays.days[0]!;

/** 113 episodes from 08:00, three minutes each; every third one repeats the app before it. */
const EPS: DayEpisode[] = Array.from({ length: 113 }, (_, i) => ({
  id: String(i + 1),
  t0: at(8, 0) + i * 180_000,
  t1: at(8, 0) + i * 180_000 + 170_000,
  app: ['Xcode', 'Safari', 'Safari', 'Terminal'][i % 4]!,
  title: `第 ${i + 1} 段`,
}));

describe('今天: timeline', () => {
  it('a session the ledger lists under two projects (a worktree and its checkout) is one entry over both spans', () => {
    const sess = (started_at: number, ended_at: number | null) => ({ session_id: '4e481841-8e5d-451e-9894-66354085e863', started_at, ended_at,
      agents_done: 0, agents_failed: 0, last_gate: null, guard_blocks: 0 });
    const t0 = at(9, 0) / 1000;
    const segments = { date: '2026-11-23', projects: [
      { project: '/r', name: 'r', sessions: [sess(t0, t0 + 600)], own: [] },
      { project: '/r/.claude/worktrees/w', name: 'w', sessions: [sess(t0 + 300, t0 + 1200)], own: [] },
    ] };
    const entries = timelineFromDay([], segments, [], [], at(14, 0)).filter((e) => e.origin === 'segment');
    expect(entries.map((e) => [e.id, e.t0, e.t1])).toEqual([['seg:4e481841-8e5d-451e-9894-66354085e863', t0 * 1000, (t0 + 1200) * 1000]]);
  });

  it('113 episodes merge same-app neighbours and show at most 30 rows, each with a time and a source icon', () => {
    const entries = timelineFromDay(EPS, null, [], [], at(14, 32));
    expect(entries.length).toBeLessThan(113);
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <DayTimeline q={{ status: 'success', data: entries }} summaries={[]} now={at(14, 32)} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    const rows = document.querySelectorAll('[data-entry]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(30);
    for (const r of rows) {
      expect(r.textContent).toMatch(/\d\d:\d\d–\d\d:\d\d/);
      expect(r.querySelector('svg[data-icon]:not([data-icon="chev"])')).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: /展开全部/ })).toBeTruthy();
  });

  it('a click on an activity entry opens its EpisodeDetail on the trace page', async () => {
    const sec = await timeline('&demo=absent');
    const row = await waitFor(() => {
      const r = sec.querySelector<HTMLElement>('[data-entry][data-source="app"]');
      expect(r).not.toBeNull();
      return r!;
    }, { timeout: 3000 });
    fireEvent.click(row);
    const sheet = await screen.findByRole('dialog', undefined, { timeout: 3000 });
    await within(sheet).findByText('删除片段', undefined, { timeout: 3000 });
  });

  it('#/overview?ep=<id> opens that episode’s detail directly', async () => {
    const e = WIRE_EPISODES[2]!;
    mount(`&ep=${e.id}`);
    const sheet = await screen.findByRole('dialog', undefined, { timeout: 3000 });
    await within(sheet).findByText(e.title, undefined, { timeout: 3000 });
    expect(within(sheet).getByText('删除片段')).toBeTruthy();
  });

  it('the episode detail deletes after a confirm and excludes its main app through /blacklist', async () => {
    const spy = vi.spyOn(getBridge().agentd, 'request');
    const sent = (method: string, prefix: string) => spy.mock.calls.filter(([m, p]) => m === method && p.startsWith(prefix));
    mount(`&ep=${E3}`);
    const sheet = await screen.findByRole('dialog', undefined, { timeout: 3000 });
    fireEvent.click(await within(sheet).findByRole('button', { name: '删除片段' }, { timeout: 3000 }));
    const dlg = await screen.findByRole('dialog', { name: /删除片段「排查 HostLink 断线」/ });
    fireEvent.click(within(dlg).getByRole('button', { name: '删除片段' }));
    await waitFor(() => expect(sent('DELETE', '/episodes/').map(([, p]) => p)).toEqual([`/episodes/${E3}`]));

    cleanup();
    mount(`&ep=${E1}`);
    const sheet2 = await screen.findByRole('dialog', undefined, { timeout: 3000 });
    fireEvent.click(await within(sheet2).findByRole('button', { name: /排除 Xcode/ }, { timeout: 3000 }));
    const ask = await screen.findByRole('dialog', { name: '排除 Xcode？' });
    fireEvent.click(within(ask).getByRole('button', { name: '排除此应用' }));
    await waitFor(() => expect(sent('POST', '/blacklist').map(([, , b]) => b)).toEqual([{ field: 'app_names', value: 'Xcode', delete_existing: false }]));
  });
});

describe('今天: 今日一句', () => {
  it('without a day summary 今日一句 carries today’s counts; with one it carries its headline', async () => {
    mount();
    const local = await screen.findByRole('region', { name: '今日摘要' }, { timeout: 3000 });
    await waitFor(() => expect(local.textContent).toMatch(/个编码会话/), { timeout: 3000 });
    expect(local.textContent).toMatch(/^今日摘要今日数据汇总，非角色生成日报/);
    cleanup();
    const request = getBridge().agentd.request.bind(getBridge().agentd);
    vi.spyOn(getBridge().agentd, 'request').mockImplementation(((method: string, path: string, body?: unknown) =>
      method === 'GET' && path.startsWith('/memory/days?')
        ? Promise.resolve({ status: 200, body: { days: [{ ...L3, date: dayOf(clock()) }] } })
        : request(method as never, path, body)) as typeof request);
    mount();
    const l3 = await screen.findByRole('region', { name: '今日摘要' }, { timeout: 3000 });
    await waitFor(() => expect(l3.textContent).toBe(`今日摘要${L3.headline}`), { timeout: 3000 });
  });
});

describe('今天: 今日一句 without the coding-sessions plug-in', () => {
  it('leaves the coding part out instead of saying there are no sessions', async () => {
    setPlugins({ 'plugins.coding_sessions': false });
    mount();
    const line = await screen.findByRole('region', { name: '今日摘要' }, { timeout: 3000 });
    await waitFor(() => expect(line.textContent).toMatch(/^今日摘要今日数据汇总，非角色生成日报下一条提醒 /), { timeout: 3000 });
    expect(line.textContent).not.toMatch(/编码会话/);
  });
});

describe('今天: work memory first, today’s reads when it is absent', () => {
  it('keeps project inferences out of Today without requesting the project list', async () => {
    const request = vi.spyOn(getBridge().agentd, 'request');
    mount();
    const line = await screen.findByRole('region', { name: '今日摘要' }, { timeout: 3000 });
    await waitFor(() => expect(line.textContent).toMatch(/个编码会话/), { timeout: 3000 });
    expect(screen.queryByRole('region', { name: '当前任务' })).toBeNull();
    expect(request.mock.calls.some(([, path]) => path.startsWith('/memory/tasks'))).toBe(false);
  });

  it('on a day with session summaries the timeline lists them, and one opens 做了什么 / 结果', async () => {
    // Today here has the fixture's sessions.
    const request = getBridge().agentd.request.bind(getBridge().agentd);
    vi.spyOn(getBridge().agentd, 'request').mockImplementation(((method: string, path: string, body?: unknown) =>
      method === 'GET' && path.startsWith('/memory/sessions?')
        ? Promise.resolve({ status: 200, body: { day: new URLSearchParams(path.split('?')[1]).get('day'), sessions: memorySessions.sessions } })
        : request(method as never, path, body)) as typeof request);
    const sec = await timeline();
    const row = await within(sec).findByRole('button', { name: new RegExp(L1.title) }, { timeout: 3000 });
    fireEvent.click(row);
    const sheet = await screen.findByRole('dialog', { name: L1.title }, { timeout: 3000 });
    expect(sheet.textContent).toContain('执行内容');
    expect(sheet.textContent).toContain(L1.did[0]!.text);
    expect(sheet.textContent).toContain('结果');
    expect(sheet.textContent).toContain(L1.outcome);
  });
});
