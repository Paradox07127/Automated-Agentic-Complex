// 记忆页的页签：档案（默认）、项目、回顾，开发者模式里还有管线；来源占比和整理批次去了管线。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { MemoryTaskResponse, MemoryTasksResponse } from '../../src/bridge/agentd-routes.generated';
import { v31Id } from '../../src/mock/memory-v31';
import { MemoryPage } from '../../src/pages/memory/Page';
import { setDevMode } from '../../src/shell/devMode';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = '';
});

function mount(search = '') {
  window.location.hash = `#/memory?still=1${search}`;
  const root = createRootRoute({
    component: () => (
      <>
        <MemoryPage />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return qc;
}

const projects = () => [...document.querySelectorAll('[data-project]')].map((r) => r.getAttribute('data-project'));
const tab = (name: string) => screen.findByRole('tab', { name: new RegExp(`^${name}`) }, { timeout: 3000 });

describe('记忆页', () => {
  it('has neither the source ratio nor the consolidation batches', async () => {
    mount();
    await screen.findAllByRole('region', { name: /^待确认：/ }, { timeout: 3000 });
    expect(screen.queryByRole('region', { name: '记忆概况' })).toBeNull();
    expect(screen.queryByText(/来源占比/)).toBeNull();
    expect(screen.queryByRole('region', { name: '最近变化' })).toBeNull();
    expect(screen.queryByText(/整理批次/)).toBeNull();
  });

  it('opens on 档案; the tabs are 档案, 项目 and 回顾, and 管线 in 开发者模式', async () => {
    setDevMode(true);
    mount();
    expect((await tab('档案')).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['档案', '项目', '回顾', '管线']);
    expect((await screen.findAllByRole('region', { name: /^待确认：/ }, { timeout: 3000 })).length).toBeGreaterThan(0);
  });

  it('回顾 lists the records; a record opens in the detail column and its evidence opens in place', async () => {
    mount('&view=activity');
    expect((await tab('回顾')).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: '搜索活动' }).getAttribute('maxlength')).toBe('500');
    expect(document.querySelector('[aria-label="记录类型"] [aria-pressed="true"]')?.getAttribute('data-stub')).toBe('IndexCell');
    fireEvent.click(await screen.findByRole('button', { name: '查看 核对渲染测试结果' }));
    const detail = await screen.findByRole('complementary', { name: '这段记录' });
    fireEvent.click(await within(detail).findByRole('button', { name: /^查看证据 1/ }));
    expect((await within(detail).findByText('本地重跑通过')).tagName).toBe('PRE');
    fireEvent.click(within(detail).getByRole('button', { name: '返回片段' }));
    await within(detail).findByRole('heading', { name: '原始证据' });
    fireEvent.click(await tab('项目'));
    expect((await tab('项目')).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
  });

  it('a project opens its goal, progress and sessions; a session opens on 今天', async () => {
    mount('&view=projects');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    const detail = await screen.findByRole('complementary', { name: '这个项目' });
    expect(within(detail).getByText('修复 HostLink 断线重连')).toBeTruthy();
    expect(detail.textContent).toContain('断线后自动恢复会话');
    expect(detail.textContent).toContain('已定位心跳超时');
    expect(await within(detail).findByText(/验证断线恢复/)).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: /在简报里看/ }));
    expect(window.location.hash).toContain('/overview?sel=ses-');
  });

  it('改目标 patches the goal with the task revision', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    const spy = vi.spyOn(bridge.agentd, 'request').mockImplementation((async (method: string, path: string, body?: unknown) =>
      method === 'PATCH' ? { status: 200, body: {} } : read(method as 'GET', path, body)) as typeof bridge.agentd.request);
    mount('&view=projects');
    const detail = await screen.findByRole('complementary', { name: '这个项目' }, { timeout: 3000 });
    fireEvent.click(within(detail).getByRole('button', { name: /^改目标/ }));
    fireEvent.change(within(detail).getByRole('textbox', { name: '目标' }), { target: { value: '断线 3 秒内恢复会话' } });
    fireEvent.click(within(detail).getByRole('button', { name: /^保存/ }));
    await waitFor(() => expect(spy.mock.calls.filter(([m]) => m === 'PATCH')).toEqual([['PATCH', '/memory/tasks/task-hostlink', { expected_revision: expect.any(Number), goal: '断线 3 秒内恢复会话' }]]));
  });

  it('a project row has a decorative index, its project, date and session count; the status cells count the tasks', async () => {
    mount('&view=projects');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    const row = document.querySelector('[data-project="task-hostlink"]') as HTMLElement;
    expect(row.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe('00.101');
    expect(row.textContent).toMatch(/修复 HostLink 断线重连Endfield\d{4}\.\d{2}\.\d{2}会话 \d+/);
    expect(screen.getByRole('button', { name: /^进行中/ }).textContent).toBe('进行中1');
    expect(screen.getByRole('button', { name: /^搁置/ }).textContent).toBe('搁置0');
    expect(screen.getByRole('button', { name: /^搁置/ }).getAttribute('data-stub')).toBe('IndexCell');
    expect(screen.getByRole('textbox', { name: '搜索项目' }).getAttribute('maxlength')).toBe('500');
  });

  it('numbers project rows across the statuses; 搁置 lists its own', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation((async (method: 'GET', path: string, body?: unknown) => {
      const r = await read(method, path, body);
      if (!path.startsWith('/memory/tasks?')) return r;
      const { tasks } = r.body as MemoryTasksResponse;
      return { ...r, body: { ...(r.body as object), tasks: [...tasks, { ...tasks[0]!, id: 'task-parked', title: '整理周报模板', status: 'parked' }] } };
    }) as typeof bridge.agentd.request);
    mount('&view=projects');
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^搁置/ }));
    await waitFor(() => expect(projects()).toEqual(['task-parked']));
    expect(document.querySelector('[data-project="task-parked"] [aria-hidden="true"]:not(svg)')?.textContent).toBe('00.102');
  });

  it('a search on 项目 filters the projects', async () => {
    mount('&view=projects&q=周报');
    expect(await screen.findByText('没有符合条件的项目', {}, { timeout: 3000 })).toBeTruthy();
    expect(projects()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    await waitFor(() => expect(projects()).toEqual(['task-hostlink']));
  });

  it('a 404 from /memory/tasks shows the standard error bar on 项目', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation((async (method: 'GET', path: string, body?: unknown) =>
      path.startsWith('/memory/tasks?') ? { status: 404, body: { error: 'not_found' } } : read(method, path, body)) as typeof bridge.agentd.request);
    mount('&view=projects');
    expect((await tab('项目')).getAttribute('aria-selected')).toBe('true');
    const bar = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(bar.textContent).toContain('没有读到项目');
    expect(within(bar).getByRole('button', { name: /重试/ })).toBeTruthy();
    expect(screen.queryByText('未接入')).toBeNull();
  });

  it('改目标 sends the revision it started from; a newer one keeps the draft and offers to load it', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    const { task } = (await read('GET', '/memory/tasks/task-hostlink')).body as MemoryTaskResponse;
    // Another window rewrites the goal once 改目标 is open: one revision later.
    let latest = { ...task };
    const spy = vi.spyOn(bridge.agentd, 'request').mockImplementation((async (method: 'GET', path: string, body?: unknown) => {
      if (path !== '/memory/tasks/task-hostlink') return read(method, path, body);
      if (method === 'GET') return { status: 200, body: { ...((await read(method, path)).body as object), task: { ...latest } } };
      const b = body as { expected_revision: number; goal: string };
      return b.expected_revision === latest.revision ? { status: 200, body: { ...latest, goal: b.goal, revision: latest.revision + 1 } } : { status: 409, body: { error: 'revision_conflict', task: latest } };
    }) as typeof bridge.agentd.request);
    const qc = mount('&view=projects');
    const detail = await screen.findByRole('complementary', { name: '这个项目' }, { timeout: 3000 });
    await within(detail).findByText(/验证断线恢复/);
    fireEvent.click(within(detail).getByRole('button', { name: /^改目标/ }));
    latest = { ...task, goal: '断线后 10 秒内恢复', revision: task.revision + 1 };
    await act(() => qc.invalidateQueries({ queryKey: ['memory', 'task', 'task-hostlink'] }));
    await within(detail).findByText(/已在别处更新为/);
    const box = within(detail).getByRole('textbox', { name: '目标' });
    fireEvent.change(box, { target: { value: '断线 5 秒内恢复会话' } });
    fireEvent.click(within(detail).getByRole('button', { name: /^保存/ }));
    await waitFor(() => expect(spy.mock.calls.filter(([m]) => m === 'PATCH')).toEqual([['PATCH', '/memory/tasks/task-hostlink', { expected_revision: task.revision, goal: '断线 5 秒内恢复会话' }]]));
    await screen.findByText('没有改：已在别处更新，已重新读取');
    expect((within(detail).getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('断线 5 秒内恢复会话');
    fireEvent.click(within(detail).getByRole('button', { name: '载入最新目标' }));
    expect((within(detail).getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('断线后 10 秒内恢复');
    fireEvent.click(within(detail).getByRole('button', { name: /^保存/ }));
    await waitFor(() => expect(spy.mock.calls.filter(([m]) => m === 'PATCH').at(-1)?.[2]).toEqual({ expected_revision: task.revision + 1, goal: '断线后 10 秒内恢复' }));
    await waitFor(() => expect(within(detail).queryByRole('textbox', { name: '目标' })).toBeNull());
  });

  it('has no 管线 tab with 开发者模式 off, and ?view=pipeline opens 档案', async () => {
    setDevMode(false);
    mount('&view=pipeline');
    expect((await tab('档案')).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['档案', '项目', '回顾']);
    expect(screen.queryByRole('tablist', { name: '工位' })).toBeNull();
  });

  it('修改 saves over the version it started from; a newer one keeps the draft and offers to load it', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    const spy = vi.spyOn(bridge.agentd, 'request');
    const id = v31Id('p2');
    const qc = mount(`&view=about&sel=${id}`);
    const detail = await screen.findByRole('complementary', { name: '这条记忆' }, { timeout: 3000 });
    fireEvent.click(within(detail).getByRole('button', { name: /^修改/ }));
    await read('PATCH', `/memory/facts/${id}`, { expected_version: 1, text: '晚上 11 点后不主动提醒' });
    await act(() => qc.invalidateQueries({ queryKey: ['memory', 'facts'] }));
    await within(detail).findByText(/已在别处更新为「晚上 11 点后不主动提醒」/);
    const box = within(detail).getByRole('textbox', { name: '修改这条记忆' });
    fireEvent.change(box, { target: { value: '晚上 9 点后不主动提醒' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(spy.mock.calls.filter(([m]) => m === 'PATCH')).toEqual([['PATCH', `/memory/facts/${id}`, { expected_version: 1, text: '晚上 9 点后不主动提醒' }]]));
    await screen.findByText('没有修改：已在别处更新，已重新读取');
    expect((within(detail).getByRole('textbox', { name: '修改这条记忆' }) as HTMLTextAreaElement).value).toBe('晚上 9 点后不主动提醒');
    fireEvent.click(within(detail).getByRole('button', { name: '载入最新版本' }));
    expect((within(detail).getByRole('textbox', { name: '修改这条记忆' }) as HTMLTextAreaElement).value).toBe('晚上 11 点后不主动提醒');
  });

  it('text typed while 修改 saves stays in the editor', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    let reply: (r: { status: number; body: unknown }) => void = () => {};
    vi.spyOn(bridge.agentd, 'request').mockImplementation(((method: string, path: string, body?: unknown) =>
      method === 'PATCH' ? new Promise<{ status: number; body: unknown }>((r) => (reply = r)) : read(method as 'GET', path, body)) as typeof bridge.agentd.request);
    mount(`&view=about&sel=${v31Id('p1')}`);
    const detail = await screen.findByRole('complementary', { name: '这条记忆' }, { timeout: 3000 });
    fireEvent.click(within(detail).getByRole('button', { name: /^修改/ }));
    const box = within(detail).getByRole('textbox', { name: '修改这条记忆' });
    fireEvent.change(box, { target: { value: '回答先给结论' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: '回答先给结论，再给理由' } });
    await act(async () => reply({ status: 200, body: { version: 2 } }));
    await screen.findByText('改好了，下一句起按新的说');
    expect((within(detail).getByRole('textbox', { name: '修改这条记忆' }) as HTMLTextAreaElement).value).toBe('回答先给结论，再给理由');
  });

  it('a rewrite agentd refuses comes back in the vote card editor', async () => {
    const bridge = getBridge();
    const read = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation((async (method: string, path: string, body?: unknown) =>
      method === 'PATCH' ? { status: 400, body: { error: 'invalid_text' } } : read(method as 'GET', path, body)) as typeof bridge.agentd.request);
    mount('&view=about');
    const c1 = await screen.findByRole('region', { name: '待确认：周报按项目分组，不按日期' }, { timeout: 3000 });
    fireEvent.click(within(c1).getByRole('button', { name: '差不多，我来改' }));
    fireEvent.change(within(c1).getByRole('textbox', { name: '改成' }), { target: { value: '周报按项目分组' } });
    fireEvent.click(within(c1).getByRole('button', { name: /改好并记住/ }));
    await screen.findByText(/^没有修改：/);
    expect((within(c1).getByRole('textbox', { name: '改成' }) as HTMLTextAreaElement).value).toBe('周报按项目分组');
  });

  it('撤销 after the rejection was already sent says so instead of 撤销了', async () => {
    const bridge = getBridge();
    const spy = vi.spyOn(bridge.agentd, 'request');
    mount('&view=about');
    const c2 = await screen.findByRole('region', { name: '待确认：写代码时减少主动发言' }, { timeout: 3000 });
    fireEvent.click(within(c2).getByRole('button', { name: '不是这样' }));
    const undo = await screen.findByRole('button', { name: '撤销' });
    fireEvent.click(screen.getByRole('button', { name: /^全部/ }));
    await waitFor(() => expect(spy.mock.calls.filter(([m, p]) => m === 'POST' && String(p).endsWith('/reject'))).toHaveLength(1));
    fireEvent.click(undo);
    expect(await screen.findByText('已经划掉了，撤销不了')).toBeTruthy();
    expect(screen.queryByText('撤销了，这条还在待确认里')).toBeNull();
  });

  it('?view=pipeline&station= opens 管线 at that station in 开发者模式', async () => {
    setDevMode(true);
    mount('&view=pipeline&station=store');
    expect((await tab('管线')).getAttribute('aria-selected')).toBe('true');
    const line = await screen.findByRole('tablist', { name: '工位' }, { timeout: 3000 });
    expect(within(line).getByRole('tab', { selected: true }).getAttribute('aria-label')).toMatch(/^记忆库：/);
    expect(await screen.findByRole('group', { name: '按来源' }, { timeout: 3000 })).toBeTruthy();
  });
});
