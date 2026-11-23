// Memory page › 档案: the nameplate and category cells, 待确认's vote cards, the list and the detail column (a drawer when narrow),
// read from the fake bridge's prototype set; writes are answered here so the mock module keeps its rows for the next case.
// 记忆概况 and 最近变化 moved to the 管线 page (pipeline-page).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { StreamEvent } from '../../src/bridge/protocol';
import { v31Id } from '../../src/mock/memory-v31';
import { added14, plateOf, useCount } from '../../src/pages/memory/model';
import { MemoryPage } from '../../src/pages/memory/Page';
import { demos } from '../../src/pages/memory/demos';
import { UNDO_MS } from '../../src/pages/memory/Votes';
import { readMemory } from '../../src/pages/memory/useFacts';
import { NOW } from '../../src/mock/fixtures';
import { ToastHost } from '../../src/shell/toast';
import { stubMatchMedia } from './mediaStub';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

type Call = [string, string, unknown?];

let calls: Call[] = [];
let emit: ((e: StreamEvent) => void) | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  delete window.agenticComplex;
  const bridge = getBridge();
  const read = bridge.agentd.request.bind(bridge.agentd);
  calls = [];
  vi.spyOn(bridge.agentd, 'request').mockImplementation(((method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (method === 'GET') return read(method as 'GET', path);
    const reply = path === '/memory/paused' ? { paused: (body as { paused: boolean }).paused } : { version: 2, deleted: true, facts_deleted: 0 };
    return Promise.resolve({ status: 200, body: reply });
  }) as typeof bridge.agentd.request);
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation((on) => {
    emit = on;
    return () => {};
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  emit = null;
  window.location.hash = '';
});

function mount(at = '?still=1') {
  const search = at.includes('view=') ? at : `${at}&view=about`;
  window.location.hash = `#/memory${search}`;
  const root = createRootRoute({
    component: () => (
      <>
        <MemoryPage />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const rows = () => [...document.querySelectorAll('[data-fact]')].map((r) => r.getAttribute('data-fact'));
const row = (key: string) => document.querySelector(`[data-fact="${v31Id(key)}"] button`) as HTMLElement;
const sent = (method: string, prefix: string) => calls.filter(([m, p]) => m === method && p.startsWith(prefix));
const cell = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
const cards = () => screen.queryAllByRole('region', { name: /^待确认：/ });
const card = (text: string) => screen.findByRole('region', { name: `待确认：${text}` });
/** 待确认 opens by default while it has asks; waits for its cards. */
const openAsks = async () => await waitFor(() => expect(cards()).toHaveLength(3), { timeout: 3000 });
/** Leaves 待确认 for 全部 once the list has loaded. */
const openAll = async () => {
  await screen.findByRole('button', { name: /^用户档案：/ });
  fireEvent.click(cell('全部'));
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
};

describe('memory › 档案', () => {
  it('opens on 待确认 with one vote card per candidate; the plate and the cells count the rest', async () => {
    mount();
    await openAsks();
    expect(cell('待确认').getAttribute('aria-pressed')).toBe('true');
    const plate = screen.getByRole('button', { name: '用户档案：小林' });
    expect(plate.textContent).toContain('3月2日');
    expect(plate.textContent).toContain('上海');
    for (const [label, n] of [['待确认', 3], ['全部', 18], ['偏好', 6], ['约定', 4], ['经历', 4], ['其他线索', 1]] as const) expect(cell(label).textContent).toBe(`${label}${n}`);
    for (const c of cards()) expect(within(within(c).getByRole('group', { name: '怎么处理' })).getAllByRole('button').map((b) => b.textContent?.replace(/\d$/, ''))).toEqual(['对，记住', '差不多，我来改', '不是这样']);
    expect(rows()).toEqual([]);
    // The count sits on the cell only; the head names the group and the explanation is behind its ⓘ.
    const asks = screen.getByRole('region', { name: '待确认' });
    expect(within(asks).getByRole('heading', { name: '待确认' })).toBeTruthy();
    expect(asks.textContent).not.toContain('[3]');
    expect(within(asks).getByRole('tooltip', { hidden: true }).textContent).toContain('你点「记住」之前');
    expect(document.body.textContent).not.toMatch(/USR|CONFIRM|FACTS|CHANGES/);
  });

  it('a card folds where she read it: closed, the kind and time; open, the chat line or the episode she saw', async () => {
    mount();
    const chat = await card('周报按项目分组，不按日期');
    const chatFold = within(chat).getByRole('button', { name: /^出处对话 │/ });
    expect(chatFold.getAttribute('aria-expanded')).toBe('false');
    expect(within(chat).queryByRole('button', { name: /去对话看原文/ })).toBeNull();
    fireEvent.click(chatFold);
    await waitFor(() => expect(chat.textContent).toContain('「按项目分组，不要按日期。」'));
    expect(within(chat).getByRole('button', { name: /去对话看原文/ })).toBeTruthy();
    const seen = await card('写代码时减少主动发言');
    fireEvent.click(within(seen).getByRole('button', { name: /^出处观察 │/ }));
    await waitFor(() => expect(seen.textContent).toMatch(/她看到：/));
    expect(within(seen).getByRole('button', { name: /在简报里看这一段/ })).toBeTruthy();
  });

  it('对，记住 confirms with the row version; 差不多，我来改 patches the new text', async () => {
    mount();
    fireEvent.click(within(await card('周报按项目分组，不按日期')).getByRole('button', { name: '对，记住' }));
    await waitFor(() => expect(sent('POST', '/memory/facts/')).toEqual([['POST', `/memory/facts/${v31Id('c1')}/confirm`, { expected_version: 1 }]]));
    expect(await screen.findByText('已记住：周报按项目分组，不按日期')).toBeTruthy();
    const c3 = await card('构建习惯用 swift build -c release');
    fireEvent.click(within(c3).getByRole('button', { name: '差不多，我来改' }));
    fireEvent.change(within(c3).getByRole('textbox', { name: '改成' }), { target: { value: '发布构建用 swift build -c release' } });
    fireEvent.click(within(c3).getByRole('button', { name: /改好并记住/ }));
    await waitFor(() => expect(sent('PATCH', '/memory/facts/')).toEqual([['PATCH', `/memory/facts/${v31Id('c3')}`, { expected_version: 1, text: '发布构建用 swift build -c release' }]]));
  });

  it('不是这样 rejects only after the 4-second undo window; 撤销 keeps the card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    fireEvent.click(within(await card('写代码时减少主动发言')).getByRole('button', { name: '不是这样' }));
    expect(await screen.findByText('划掉了，她不会再记这件事')).toBeTruthy();
    expect(sent('POST', '/memory/facts/')).toEqual([]);
    act(() => void vi.advanceTimersByTime(UNDO_MS));
    await waitFor(() => expect(sent('POST', '/memory/facts/')).toEqual([['POST', `/memory/facts/${v31Id('c2')}/reject`, { expected_version: 1 }]]));

    const c1 = await card('周报按项目分组，不按日期');
    fireEvent.click(within(c1).getByRole('button', { name: '不是这样' }));
    const undo = await waitFor(() => screen.getAllByRole('button', { name: '撤销' }).at(-1)!);
    fireEvent.click(undo);
    act(() => void vi.advanceTimersByTime(UNDO_MS));
    expect(sent('POST', `/memory/facts/${v31Id('c1')}`)).toEqual([]);
    expect(within(c1).getByRole('button', { name: '对，记住' })).toBeTruthy();
  });

  it('剩下 N 条全部记住 confirms each card on its own; key 1 confirms the first open card', async () => {
    mount();
    await openAsks();
    fireEvent.keyDown(window, { key: '1' });
    await waitFor(() => expect(sent('POST', '/memory/facts/')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /^剩下 \d 条全部记住/ }));
    await waitFor(() => expect([...new Set(sent('POST', '/memory/facts/').map(([, p]) => p))].sort()).toEqual(['c1', 'c2', 'c3'].map((k) => `/memory/facts/${v31Id(k)}/confirm`).sort()));
  });

  it('全部 lists the facts in five groups; the detail column shows the first row', async () => {
    mount();
    await openAll();
    expect(rows()).toHaveLength(18);
    for (const g of ['用户档案', '偏好', '约定', '经历', '其他线索']) expect(screen.getByRole('group', { name: g })).toBeTruthy();
    const detail = screen.getByRole('complementary', { name: '这条记忆' });
    expect(within(detail).getByRole('region', { name: '出处' })).toBeTruthy();
    expect(within(detail).getByRole('img', { name: /近 14 天用到 \d+ 次/ })).toBeTruthy();
    expect(document.querySelector('[data-fact] button')?.getAttribute('aria-pressed')).toBe('true');
    expect(within(document.querySelector(`[data-fact="${v31Id('a2')}"]`)!).getByText('30 天没用到')).toBeTruthy();
  });

  it('?src= lands as a search for that source, and 清除搜索 brings the rest back', async () => {
    mount('?still=1&src=observed');
    await openAll();
    expect(rows().sort()).toEqual(['a3', 'p4', 'x1'].map(v31Id).sort());
    expect((screen.getByRole('textbox', { name: '搜索记忆' }) as HTMLInputElement).value).toBe('观察所得');
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(rows()).toHaveLength(18);
  });

  it('search drops the groups; another sort lists one run of rows', async () => {
    mount('?still=1&q=周报');
    await openAll();
    expect(rows().sort()).toEqual(['g1', 'x3'].map(v31Id).sort());
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    fireEvent.change(screen.getByRole('combobox', { name: '排序' }), { target: { value: 'idle' } });
    expect(screen.queryByRole('group', { name: '偏好' })).toBeNull();
    expect(rows()).toHaveLength(18);
  });

  it('a chat-sourced fact quotes the line it was read from', async () => {
    mount(`?still=1&sel=${v31Id('g2')}`);
    const detail = await screen.findByRole('complementary', { name: '这条记忆' });
    expect(await within(detail).findByText(/以后提交前先跑一遍 swift test。/)).toBeTruthy();
    expect(within(detail).getByRole('button', { name: /去对话看原文/ })).toBeTruthy();
    expect(within(detail).getByText('你在对话里亲口说的')).toBeTruthy();
  });

  it('an observed fact names what she saw', async () => {
    mount(`?still=1&sel=${v31Id('a3')}`);
    const detail = await screen.findByRole('complementary', { name: '这条记忆' });
    expect(await within(detail).findByText(/她看到：/)).toBeTruthy();
    expect(within(detail).getByRole('button', { name: /在简报里看这一段/ })).toBeTruthy();
  });

  it('删除 asks on a paper card first, then sends DELETE with the version', async () => {
    mount(`?still=1&sel=${v31Id('p5')}`);
    const detail = await screen.findByRole('complementary', { name: '这条记忆' });
    fireEvent.click(within(detail).getByRole('button', { name: '删除' }));
    expect(sent('DELETE', '/memory/facts/')).toEqual([]);
    const ask = await screen.findByRole('alertdialog', { name: '删除这条记忆？' });
    fireEvent.click(within(ask).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(sent('DELETE', '/memory/facts/')).toEqual([['DELETE', `/memory/facts/${v31Id('p5')}?expected_version=1`, undefined]]));
  });

  it('修改 edits in the detail column; Enter saves with the row version', async () => {
    mount(`?still=1&sel=${v31Id('p2')}`);
    const detail = await screen.findByRole('complementary', { name: '这条记忆' });
    fireEvent.click(within(detail).getByRole('button', { name: /^修改/ }));
    const input = within(detail).getByRole('textbox', { name: '修改这条记忆' });
    fireEvent.change(input, { target: { value: '晚上 11 点后不主动提醒' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent('PATCH', '/memory/facts/')).toEqual([['PATCH', `/memory/facts/${v31Id('p2')}`, { expected_version: 1, text: '晚上 11 点后不主动提醒' }]]));
  });

  it('below 1200 px a row opens the detail as a drawer, and Esc closes it', async () => {
    stubMatchMedia(new Set(['(max-width: 1199px)']));
    mount();
    await openAll();
    expect(screen.queryByRole('complementary', { name: '这条记忆' })).toBeNull();
    fireEvent.click(row('p1'));
    const drawer = await screen.findByRole('dialog', { name: '这条记忆' });
    expect(within(drawer).getByText('回答先给结论，再给细节')).toBeTruthy();
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: '关闭' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '这条记忆' })).toBeNull());
  });

  it('暂停记忆 sends PUT /memory/paused and the header says 已暂停记忆', async () => {
    mount();
    await openAsks();
    fireEvent.click(screen.getByRole('button', { name: '暂停记忆' }));
    await waitFor(() => expect(sent('PUT', '/memory/paused')).toEqual([['PUT', '/memory/paused', { paused: true }]]));
    expect(await screen.findByRole('button', { name: /恢复记忆/ })).toBeTruthy();
    expect(screen.getAllByRole('status').some((el) => el.textContent?.startsWith('已暂停记忆'))).toBe(true);
  });

  it('a /feed memory event re-reads the facts', async () => {
    mount();
    await openAsks();
    const reads = sent('GET', '/memory').filter(([, p]) => p === '/memory').length;
    act(() => emit?.({ event: 'memory', id: '9', data: JSON.stringify({ action: 'added', fact_id: 'f0live', text: '测试日志只看失败的几行' }) }));
    await waitFor(() => expect(sent('GET', '/memory').filter(([, p]) => p === '/memory').length).toBeGreaterThan(reads));
  });

  it('⌘F focuses the search box', async () => {
    mount();
    await openAll();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索记忆' }));
  });
});

describe('memory › demos', () => {
  it('lists the prototype demos', () => {
    const names = demos.map((d) => d.name);
    for (const n of ['default', 'sparse', 'empty', 'paused', 'loading', 'error', 'light', 'detail', 'projects', 'review']) expect(names).toContain(n);
  });

  it('sparse: no asks, so it opens on 全部 without a 待确认 cell', async () => {
    mount('?still=1&demo=sparse');
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 3000 });
    expect(cell('全部').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /^待确认/ })).toBeNull();
    expect(cards()).toEqual([]);
  });

  it('empty: one line with 去对话, and 新增 still opens the add card', async () => {
    mount('?still=1&state=empty');
    expect(await screen.findByText('她还没记住你的事')).toBeTruthy();
    expect(screen.getByRole('button', { name: /去对话/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '用户档案' }).textContent).toContain('还不知道怎么称呼你');
    expect(document.body.textContent).not.toContain('暂无');
    fireEvent.click(screen.getByRole('button', { name: /^新增/ }));
    expect(await screen.findByRole('dialog', { name: '新增一条记忆' })).toBeTruthy();
  });

  it('empty 回顾: one line with the reason and one action', async () => {
    mount('?still=1&state=empty&view=activity');
    const review = await screen.findByRole('region', { name: '回顾' });
    expect(await within(review).findByText('还没有整理出的工作片段')).toBeTruthy();
    expect(review.textContent).not.toContain('可切换到原始观察');
    expect(within(review).getByRole('button', { name: '打开观察设置' })).toBeTruthy();
  });

  it('error: one banner with 重试, no rows', async () => {
    mount('?still=1&state=error');
    expect(await screen.findByText(/没有读到记忆：记忆库正在被另一个进程写入/)).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(rows()).toEqual([]);
  });

  it('paused: 恢复记忆 in the command bar and the header says 已暂停记忆', async () => {
    mount('?still=1&demo=paused');
    await openAsks();
    expect(screen.getByRole('button', { name: /恢复记忆/ })).toBeTruthy();
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBeLessThanOrEqual(1);
    expect(screen.getAllByRole('status').some((el) => el.textContent?.startsWith('已暂停记忆'))).toBe(true);
  });
});

describe('memory › model', () => {
  it('counts 14-day additions from recorded_at, skipping candidates; the plate reads the about facts', async () => {
    window.location.hash = '#/memory';
    const { facts } = await readMemory(NOW);
    const added = added14(facts, NOW);
    expect(added).toHaveLength(14);
    expect(added[13]).toBe(4);
    expect(plateOf(facts)).toEqual({ name: '小林', birthday: '3月2日', place: '上海', about: 3 });
    expect(useCount(facts.find((f) => f.id === v31Id('a1'))!)).toBe('5+');
  });
});
