// Memory page › 关于你: one-line profile, folded 待确认, the list and the detail sheet,
// read from the fake bridge's prototype set; writes are answered here so the mock module keeps its rows for the next case.
// 记忆概况 and 最近变化 moved to the 管线 page (pipeline-page).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { StreamEvent } from '../../src/bridge/protocol';
import { v31Id } from '../../src/mock/memory-v31';
import { added14, profileOf, useCount } from '../../src/pages/memory/model';
import { MemoryPage } from '../../src/pages/memory/Page';
import { demos } from '../../src/pages/memory/demos';
import { readMemory } from '../../src/pages/memory/useFacts';
import { NOW } from '../../src/mock/fixtures';
import { ToastHost } from '../../src/shell/toast';

type Call = [string, string, unknown?];

let calls: Call[] = [];
let emit: ((e: StreamEvent) => void) | null = null;

beforeEach(() => {
  // jsdom has no layout; the overview's filter scrolls the list into view.
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
  vi.restoreAllMocks();
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
const row = (key: string) => document.querySelector(`[data-fact="${v31Id(key)}"]`) as HTMLElement;
const sent = (method: string, prefix: string) => calls.filter(([m, p]) => m === method && p.startsWith(prefix));
/** 待确认 opens by default while it has asks; waits for its cards. */
const openAsks = async () => expect(await screen.findByRole('button', { name: '收起「待确认」' })).toBeTruthy();

describe('memory › blocks', () => {
  it('draws the profile line, three open asks and the list in four groups', async () => {
    mount();
    expect(await screen.findByText('小林')).toBeTruthy();
    const plate = screen.getByRole('region', { name: '用户档案' });
    expect(within(plate).getByText('3月2日')).toBeTruthy();
    expect(within(plate).getByText('上海')).toBeTruthy();
    for (const label of ['偏好', '约定']) expect(within(plate).getByText(label)).toBeTruthy();
    expect(within(plate).getByText('提交前先跑 swift test')).toBeTruthy();

    expect(screen.queryByText(/每天上限/)).toBeNull();
    expect(screen.getAllByRole('region', { name: /^待确认：/ })).toHaveLength(2);
    expect(document.querySelector('main, body')?.textContent).not.toMatch(/USR|CONFIRM|FACTS|CHANGES/);

    expect(rows()).toHaveLength(11);
    for (const g of ['基本信息', '偏好', '约定']) expect(screen.getByRole('group', { name: g })).toBeTruthy();
    expect(within(row('a2')).getByText('休眠')).toBeTruthy();
    expect(within(row('a1')).getByText('称呼：小林')).toBeTruthy();
    expect(screen.getByText('上次整理').textContent).toBeTruthy();
  });

  it('says the header status as one │-separated field line', async () => {
    mount();
    await screen.findByText('小林');
    const line = screen.getAllByRole('status').find((el) => el.textContent?.includes('上次整理'));
    expect(line?.textContent).toMatch(/^记录中│待确认 3│已记住 16│上次整理 \d\d:\d\d$/);
  });

  it('draws 用户档案 as key/value blocks, each with its source as a field; asks and facts use the shared rows', async () => {
    mount();
    const plate = await screen.findByRole('region', { name: '用户档案' });
    await within(plate).findByText('小林');
    const blocks = [...plate.querySelectorAll('[data-stub="KV"]')];
    expect(blocks.map((b) => b.querySelector('dt')?.textContent)).toEqual(['称呼', '生日', '时区', '偏好', '约定']);
    for (const b of blocks) expect(b.parentElement?.textContent).toMatch(/(用户陈述|观察所得|用户确认|推断)$/);
    expect(within(plate).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      '称呼：小林，查看出处',
      expect.stringMatching(/^偏好：/),
      expect.stringMatching(/^约定：/),
    ]);
    for (const ask of screen.getAllByRole('region', { name: /^待确认：/ })) expect(ask.querySelector('[data-stub="SRow"]')).toBeTruthy();
    expect(row('a1').querySelector('[data-stub="RowPlate"] button[aria-pressed]')).toBeTruthy();
  });

  it('keeps these controls off real data: no 停止此类推断, 撤销本批, 不再提及 or 版本历史', async () => {
    mount(`?still=1&sel=${v31Id('a3')}`);
    expect(await screen.findByRole('dialog', { name: '记忆详情' })).toBeTruthy();
    expect(screen.queryByText('停止此类推断')).toBeNull();
    expect(screen.queryByText('撤销本批')).toBeNull();
    expect(screen.queryByText('版本历史')).toBeNull();
    expect(screen.queryByRole('button', { name: '不再提及' })).toBeNull();
  });

  it('shows them in the full demo', async () => {
    expect(demos.find((d) => d.name === 'full')?.params).toEqual({ demo: 'full', view: 'about' });
    mount(`?still=1&demo=full&sel=${v31Id('a3')}`);
    const sheet = await screen.findByRole('dialog', { name: '记忆详情' });
    expect(within(sheet).getByText('版本历史')).toBeTruthy();
    expect(within(sheet).getByText('在 Endfield 仓库工作')).toBeTruthy();
    await openAsks();
    expect(screen.getAllByText('停止此类推断')).toHaveLength(2);
    expect(row('x4')).toBeNull(); // project/experience records have their own view
    expect(within(row('p1')).getByText('已锁定')).toBeTruthy();
  });
});

describe('memory › interactions', () => {
  it('?src= filters the list to one source, and 清除筛选 brings the rest back', async () => {
    mount('?still=1&src=observed');
    await screen.findByText('小林');
    expect(rows().sort()).toEqual([v31Id('p4')]);
    expect(screen.getByText(/只看「观察」/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /清除筛选/ }));
    expect(rows()).toHaveLength(11);
  });

  it('search and sort keep the groups', async () => {
    mount('?still=1&q=周报');
    await screen.findByText('小林');
    expect(rows().sort()).toEqual([v31Id('g1')]);
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    fireEvent.click(screen.getByRole('radio', { name: '最久未用' }));
    const about = within(screen.getByRole('group', { name: '基本信息' }));
    expect(about.getAllByRole('button', { pressed: false })[0]?.textContent).toContain('生日');
  });

  it('记住 / 不是这样 / 修改 send candidate decisions and patch with the row version', async () => {
    mount();
    await openAsks();
    const [c1, c2] = await screen.findAllByRole('region', { name: /^待确认：/ });
    fireEvent.click(within(c1!).getByRole('button', { name: '记住' }));
    await waitFor(() => expect(sent('POST', '/memory/facts/')).toEqual([['POST', `/memory/facts/${v31Id('c1')}/confirm`, { expected_version: 1 }]]));
    fireEvent.click(within(c2!).getByRole('button', { name: '不是这样' }));
    await waitFor(() => expect(sent('POST', `/memory/facts/${v31Id('c2')}`)).toEqual([['POST', `/memory/facts/${v31Id('c2')}/reject`, { expected_version: 1 }]]));
    fireEvent.click(screen.getByRole('tab', { name: '其他事实与线索' }));
    const c3 = await screen.findByRole('region', { name: '待确认：构建习惯用 swift build -c release' });
    fireEvent.click(within(c3).getByRole('button', { name: '修改' }));
    fireEvent.change(within(c3!).getByRole('textbox', { name: '修改为' }), { target: { value: '发布构建用 swift build -c release' } });
    fireEvent.click(within(c3!).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent('PATCH', '/memory/facts/')).toEqual([['PATCH', `/memory/facts/${v31Id('c3')}`, { expected_version: 1, text: '发布构建用 swift build -c release' }]]));
    expect(await screen.findByText('已确认：周报按项目分组，不按日期')).toBeTruthy();
  });

  it('shows candidate source lines and updates header counts after both decisions', async () => {
    window.location.hash = '#/memory?still=1';
    const bridge = getBridge();
    const read = vi.mocked(bridge.agentd.request).getMockImplementation()!;
    const response = await read('GET', '/memory');
    const memory = structuredClone(response.body) as { facts: Array<{ fact_id: string; state?: string; source: string; version: number }> };
    vi.mocked(bridge.agentd.request).mockImplementation(((method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/memory') return Promise.resolve({ status: 200, body: memory });
      if (method === 'POST' && /\/(confirm|reject)$/.test(path)) {
        const id = path.split('/')[3];
        const f = memory.facts.find((x) => x.fact_id === id)!;
        if (path.endsWith('/reject')) memory.facts = memory.facts.filter((x) => x !== f);
        else { delete f.state; f.source = 'confirmed_by_user'; f.version += 1; }
        return Promise.resolve({ status: 200, body: { version: f.version, rejected: true } });
      }
      return read(method as 'GET', path, body);
    }) as typeof bridge.agentd.request);
    mount();
    await openAsks();
    const counts = () => screen.getByRole('status', { name: '记忆数量' }).textContent;
    expect(counts()).toBe('待确认 3│已记住 16');
    const cards = () => screen.getAllByRole('region', { name: /^待确认：/ });
    await waitFor(() => expect(cards()[0]!.querySelector('[class*="evMeta"]')?.textContent).toMatch(/\d.*对话/));
    for (const card of cards()) {
      expect(within(card).getByRole('button', { name: '记住' })).toBeTruthy();
      expect(within(card).getByRole('button', { name: '不是这样' })).toBeTruthy();
    }
    fireEvent.click(within(cards()[0]!).getByRole('button', { name: '记住' }));
    await waitFor(() => expect(counts()).toBe('待确认 2│已记住 17'));
    fireEvent.click(within(cards()[0]!).getByRole('button', { name: '不是这样' }));
    await waitFor(() => expect(counts()).toBe('待确认 1│已记住 17'));
  });

  it('keeps the learned date and source when the source journal has expired', async () => {
    const bridge = getBridge();
    const read = vi.mocked(bridge.agentd.request).getMockImplementation()!;
    vi.mocked(bridge.agentd.request).mockImplementation(((method: string, path: string, body?: unknown) =>
      method === 'GET' && path.startsWith('/memory/runs/')
        ? Promise.resolve({ status: 404, body: { error: 'unknown_memory_run' } })
        : read(method as 'GET', path, body)) as typeof bridge.agentd.request);
    mount();
    const card = await screen.findByRole('region', { name: '待确认：周报按项目分组，不按日期' });
    await waitFor(() => expect(card.querySelector('[class*="evMeta"]')?.textContent).toMatch(/\d.*对话/));
  });

  it('a row opens the detail sheet with its source and uses; Esc closes it', async () => {
    mount();
    await screen.findByText('小林');
    fireEvent.click(screen.getByRole('tab', { name: '其他事实与线索' }));
    await waitFor(() => expect(row('a3')).toBeTruthy());
    fireEvent.click(row('a3').querySelector('button[aria-pressed]')!);
    const sheet = await screen.findByRole('dialog', { name: '记忆详情' });
    expect(within(sheet).getByText('出处')).toBeTruthy();
    expect(await within(sheet).findByText('观察 │ 排查 HostLink 断线')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: '查看片段' })).toBeTruthy();
    expect(within(sheet).getByRole('img', { name: /近 14 天引用 \d+ 次/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '记忆详情' })).toBeNull());
  });

  it('a chat-sourced fact quotes the line it was read from', async () => {
    mount(`?still=1&sel=${v31Id('g2')}`);
    const sheet = await screen.findByRole('dialog', { name: '记忆详情' });
    expect(await within(sheet).findByText(/以后提交前先跑一遍 swift test。/)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: '查看原文' })).toBeTruthy();
  });

  it('删除 asks first, then sends DELETE with the version', async () => {
    mount();
    await screen.findByText('小林');
    fireEvent.click(within(row('p5')).getByRole('button', { name: '删除' }));
    expect(sent('DELETE', '/memory/facts/')).toEqual([]);
    const dialog = await screen.findByRole('dialog', { name: '删除这条记忆？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(sent('DELETE', '/memory/facts/')).toEqual([['DELETE', `/memory/facts/${v31Id('p5')}?expected_version=1`, undefined]]));
  });

  it('修改 on a row patches it inline', async () => {
    mount();
    await screen.findByText('小林');
    fireEvent.click(within(row('p2')).getByRole('button', { name: '修改' }));
    const input = screen.getByRole('textbox', { name: '修改这条记忆' });
    fireEvent.change(input, { target: { value: '晚上 11 点后不主动提醒' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent('PATCH', '/memory/facts/')).toEqual([['PATCH', `/memory/facts/${v31Id('p2')}`, { expected_version: 1, text: '晚上 11 点后不主动提醒' }]]));
  });

  it('暂停记忆 sends PUT /memory/paused and the header says 已暂停', async () => {
    mount();
    await screen.findByText('小林');
    fireEvent.click(screen.getByRole('button', { name: '暂停记忆' }));
    await waitFor(() => expect(sent('PUT', '/memory/paused')).toEqual([['PUT', '/memory/paused', { paused: true }]]));
    expect(await screen.findByRole('button', { name: '恢复记忆' })).toBeTruthy();
    expect(screen.getAllByRole('status').find((el) => el.textContent?.includes('上次整理'))?.textContent).toContain('已暂停');
  });

  it('a /feed memory event re-reads the facts', async () => {
    mount();
    await screen.findByText('小林');
    const reads = sent('GET', '/memory').filter(([, p]) => p === '/memory').length;
    act(() => emit?.({ event: 'memory', id: '9', data: JSON.stringify({ action: 'added', fact_id: 'f0live', text: '测试日志只看失败的几行' }) }));
    await waitFor(() => expect(sent('GET', '/memory').filter(([, p]) => p === '/memory').length).toBeGreaterThan(reads));
  });

  it('⌘F focuses the search box', async () => {
    mount();
    await screen.findByText('小林');
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索记忆' }));
  });
});

describe('memory › demos', () => {
  it('lists the prototype demos', () => {
    const names = demos.map((d) => d.name);
    for (const n of ['default', 'sparse', 'empty', 'paused', 'loading', 'error', 'light', 'full']) expect(names).toContain(n);
  });

  it('sparse: six facts, no asks', async () => {
    mount('?still=1&demo=sparse');
    await screen.findByText('小林');
    expect(rows()).toHaveLength(4);
    expect(screen.getByText('没有待确认的推断')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '展开「待确认」' })).toBeNull();
  });

  it('empty: one centered empty state with 去对话, the sections hidden', async () => {
    mount('?still=1&state=empty');
    expect(await screen.findByText('还没有记忆')).toBeTruthy();
    expect(screen.getByRole('button', { name: /去对话/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '用户档案' })).toBeNull();
    expect(screen.queryByRole('region', { name: '最近变化' })).toBeNull();
    expect(screen.queryByRole('toolbar', { name: '搜索、排序、分组跳转' })).toBeNull();
    expect(document.body.textContent).not.toContain('暂无');
  });

  it('empty activity: one line with the reason and one action', async () => {
    mount('?still=1&state=empty&view=activity');
    const activity = await screen.findByRole('region', { name: '活动回顾' });
    const empty = await within(activity).findByText('还没有整理出的工作片段');
    const box = empty.parentElement!;
    expect(box.textContent).not.toContain('可切换到原始观察');
    expect(within(box).getAllByRole('button').map((b) => b.textContent)).toEqual(['打开观察设置']);
  });

  it('empty: 新增记忆 still opens the add dialog', async () => {
    mount('?still=1&state=empty');
    expect(await screen.findByText('还没有记忆')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /新增记忆/ }));
    expect(await screen.findByRole('dialog', { name: '新增记忆' })).toBeTruthy();
  });

  it('error: one banner with 重试, no rows', async () => {
    mount('?still=1&state=error');
    expect(await screen.findByText(/没有读到记忆：记忆库正在被另一个进程写入/)).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').getAttribute('data-stub')).toBe('ErrBar');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(rows()).toEqual([]);
    expect(screen.queryByRole('region', { name: '用户档案' })).toBeNull();
  });

  it('paused: 恢复记忆 is the one primary button and the header says 已暂停', async () => {
    mount('?still=1&demo=paused');
    await screen.findByText('小林');
    expect(screen.getByRole('button', { name: '恢复记忆' }).getAttribute('data-variant')).toBe('primary');
    expect(document.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(screen.getAllByRole('status').find((el) => el.textContent?.includes('上次整理'))?.textContent).toContain('已暂停');
  });
});

describe('memory › model', () => {
  it('counts 14-day additions from recorded_at, skipping candidates', async () => {
    window.location.hash = '#/memory';
    const { facts } = await readMemory(NOW);
    const added = added14(facts, NOW);
    expect(added).toHaveLength(14);
    expect(added[13]).toBe(4);
    const p = profileOf(facts);
    expect(p.name?.text).toBe('小林');
    expect(p.cells.map((c) => c.label)).toEqual(['偏好', '约定']);
    expect(useCount(facts.find((f) => f.id === v31Id('a1'))!)).toBe('5+');
  });
});
