import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickedHandle, StreamEvent } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockResponse, MockRoute } from '../../src/mock';
import { NOW } from '../../src/mock/fixtures';
import { C1 } from '../../src/mock/fixtures/ids';
import { ChatPage } from '../../src/pages/chat/Page';
import { shortName } from '../../src/pages/chat/scope';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
  window.location.hash = '';
});

const FOLDER: PickedHandle = { handle: 'h-folder', displayName: '周报' };
const FILE: PickedHandle = { handle: 'h-file', displayName: '销量.csv' };
const sec = NOW / 1000;
const scope = (id: string, over: Record<string, unknown> = {}) => ({
  scope_id: id, revision: 1, roots: [{ path: '/Users/lin/周报' }], files: [], output: { path: '/x' }, created_at: sec - 60, expires_at: sec + 3600, revoked: false, ...over,
});

/** The bodies sent to `/messages` and `POST /agent/scopes`, the picker calls, and `emit` for a feed event. */
function bridge(scopes: unknown[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  let n = 0;
  const bodies: unknown[] = [];
  const made: unknown[] = [];
  const routes: MockRoute[] = [
    { method: 'POST', path: '/conversations/:id/messages', handler: ({ body }) => (++n, bodies.push(body), { status: 202, body: { line_id: `line-${n}`, generation: 43, run_id: `run-${n}`, runtime: 'codex' } }) },
    { method: 'POST', path: '/agent/scopes', handler: ({ body }): MockResponse => (made.push(body), { status: 201, body: scope(`scope-${made.length}`) }) },
    { method: 'GET', path: '/agent/scopes', handler: () => ({ status: 200, body: { scopes } }) },
  ];
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const pickFolder = vi.fn(async () => FOLDER);
  const pickFile = vi.fn(async () => FILE);
  let onEvent: ((e: StreamEvent) => void) | null = null;
  window.agenticComplex = { ...base, files: { ...base.files, pickFolder, pickFile }, feed: { subscribe: (e) => ((onEvent = e), () => {}) } };
  const emit = (event: string, data: unknown) => act(() => onEvent?.({ event, id: null, data: JSON.stringify(data) }));
  return { bodies, made, pickFolder, pickFile, emit };
}

async function mount() {
  const root = createRootRoute({ component: ChatPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const thread = await screen.findByRole('region', { name: '消息' });
  await within(thread).findByText('按项目分组，不要按日期。');
  return thread;
}

async function send(thread: HTMLElement, text: string, n: number) {
  fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: text } });
  fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
  await waitFor(() => expect(thread.querySelector(`[data-live="line-${n}"]`)).toBeTruthy());
  return thread.querySelector<HTMLElement>(`[data-live="line-${n}"]`)!;
}

async function choose(thread: HTMLElement, item: string) {
  fireEvent.click(within(thread).getByRole('button', { name: /^资料/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

describe('资料 on the chat composer', () => {
  it('a picked folder becomes a scope, and every line sends its scope_id until ×', async () => {
    const b = bridge();
    const thread = await mount();
    await choose(thread, '选文件夹…');
    expect(await within(thread).findByRole('button', { name: /^周报/ })).toBeTruthy();
    expect(b.pickFolder).toHaveBeenCalledWith({ purpose: 'scope_root' });
    expect(b.made).toEqual([{ roots: [FOLDER] }]);

    await send(thread, '汇总一下', 1);
    await send(thread, '再看一遍', 2);
    fireEvent.click(within(thread).getByRole('button', { name: '这次不带资料' }));
    await send(thread, '不带了', 3);
    expect(b.bodies).toEqual([{ text: '汇总一下', scope_id: 'scope-1' }, { text: '再看一遍', scope_id: 'scope-1' }, { text: '不带了' }]);
    expect(b.made).toHaveLength(1);
  });

  it('a picked file goes out as files with the scope_file handle', async () => {
    const b = bridge();
    const thread = await mount();
    await choose(thread, '选文件…');
    expect(await within(thread).findByRole('button', { name: /^销量\.csv/ })).toBeTruthy();
    expect(b.pickFile).toHaveBeenCalledWith({ purpose: 'scope_file' });
    expect(b.made).toEqual([{ files: [FILE] }]);
  });

  it('a long 资料 name is cut in the middle and keeps its ending', () => {
    expect(shortName('销量.csv')).toBe('销量.csv');
    expect(shortName('2026-quarterly-expenses-synthetic-final-v3.csv')).toBe('2026-quarterly-e…-v3.csv');
    expect(shortName('二零二六年第三季度报销明细汇总表最终版.xlsx')).toBe('二零二六年第三…终版.xlsx');
  });

  it('the 资料 chip shows the short name and its title the whole name', async () => {
    const long = '2026-quarterly-expenses-synthetic-final-v3.csv';
    const b = bridge([scope('s-long', { roots: [], files: [{ path: `/Users/lin/${long}` }] })]);
    const thread = await mount();
    await choose(thread, '用最近的资料');
    const chip = await within(thread).findByRole('button', { name: /^2026-quarterly-e…-v3\.csv/ });
    expect(chip.closest('[title]')?.getAttribute('title')).toBe(long);
    expect(b.made).toEqual([]);
  });

  it('no 资料 picked: the body has no scope_id', async () => {
    const b = bridge();
    const thread = await mount();
    await send(thread, '你好', 1);
    expect(b.bodies).toEqual([{ text: '你好' }]);
  });

  it('本轮不记录 greys 资料 out and the picked scope stays home', async () => {
    const b = bridge();
    const thread = await mount();
    await choose(thread, '选文件夹…');
    await within(thread).findByRole('button', { name: /^周报/ });
    fireEvent.click(within(thread).getByRole('button', { name: /本轮不记录/ }));
    const chip = within(thread).getByRole('button', { name: '周报' });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute('title')).toBe('临时对话不带资料');
    await send(thread, '只说一次', 1);
    expect(b.bodies).toEqual([{ text: '只说一次', no_memory: true }]);
  });

  it('用最近的资料 takes the newest live scope, skipping revoked and expired ones', async () => {
    const b = bridge([
      scope('revoked', { created_at: sec - 10, revoked: true }),
      scope('expired', { created_at: sec - 20, expires_at: sec - 1 }),
      scope('older', { created_at: sec - 300 }),
      scope('newest', { created_at: sec - 30, roots: [], files: [{ path: '/a/1.md' }, { path: '/a/2.md' }] }),
    ]);
    const thread = await mount();
    await choose(thread, '用最近的资料');
    expect(await within(thread).findByRole('button', { name: /^2 个文件/ })).toBeTruthy();
    await send(thread, '对比一下', 1);
    expect(b.bodies).toEqual([{ text: '对比一下', scope_id: 'newest' }]);
    expect(b.made).toEqual([]);
  });

  it('用最近的资料 with none live says so', async () => {
    bridge([scope('revoked', { revoked: true })]);
    const thread = await mount();
    await choose(thread, '用最近的资料');
    expect(await within(thread).findByText('还没有可用的资料')).toBeTruthy();
  });

  it('重试 sends the same scope_id again', async () => {
    const b = bridge();
    const thread = await mount();
    await choose(thread, '选文件夹…');
    await within(thread).findByRole('button', { name: /^周报/ });
    fireEvent.click(within(thread).getByRole('button', { name: '这次不带资料' }));
    await choose(thread, '选文件夹…');
    await within(thread).findByRole('button', { name: /^周报/ });
    const net = await send(thread, '汇总一下', 1);
    fireEvent.click(within(thread).getByRole('button', { name: '这次不带资料' }));
    b.emit('agent_run', { run_id: 'run-1', phase: 'failed', conversation_id: C1, work_kind: 'foreground', error: 'network', code: 'network', retryable: true, public_message: '连接服务失败，请稍后重试。' });
    b.emit('line', { line_id: 'line-1', text_delta: '', final: true, conversation_id: C1, run_id: 'run-1', error: 'network', cancelled: false });
    fireEvent.click(await within(net).findByRole('button', { name: '重试' }));
    await waitFor(() => expect(thread.querySelector('[data-live="line-2"]')).toBeTruthy());
    expect(b.bodies).toEqual([{ text: '汇总一下', scope_id: 'scope-2' }, { text: '汇总一下', scope_id: 'scope-2' }]);
  });
});
