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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
  window.location.hash = '';
});

const FILE: PickedHandle = { handle: 'h-file', displayName: '销量.csv' };
const sec = NOW / 1000;
const scope = (id: string) => ({
  scope_id: id, revision: 1, roots: [], files: [{ path: '/Users/lin/销量.csv' }], output: { path: '/x' }, created_at: sec - 60, expires_at: sec + 3600, revoked: false,
});

/** The bodies sent to `/messages` and `POST /agent/scopes`, the picker call, and `emit` for a feed event. */
function bridge() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  let n = 0;
  const bodies: unknown[] = [];
  const made: unknown[] = [];
  const routes: MockRoute[] = [
    { method: 'POST', path: '/conversations/:id/messages', handler: ({ body }) => (++n, bodies.push(body), { status: 202, body: { line_id: `line-${n}`, generation: 43, run_id: `run-${n}`, runtime: 'codex' } }) },
    { method: 'POST', path: '/agent/scopes', handler: ({ body }): MockResponse => (made.push(body), { status: 201, body: scope(`scope-${made.length}`) }) },
  ];
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const pickFile = vi.fn(async () => FILE);
  let onEvent: ((e: StreamEvent) => void) | null = null;
  window.agenticComplex = { ...base, files: { ...base.files, pickFile }, feed: { subscribe: (e) => ((onEvent = e), () => {}) } };
  const emit = (event: string, data: unknown) => act(() => onEvent?.({ event, id: null, data: JSON.stringify(data) }));
  return { bodies, made, pickFile, emit };
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

async function attach(thread: HTMLElement) {
  fireEvent.click(within(thread).getByRole('button', { name: '附加' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '添加文件或图片' }));
  return within(thread).findByText(FILE.displayName);
}

// A picked file waits in the tray; sending turns the tray into one POST /agent/scopes and the line carries its scope_id.
describe('files on the chat composer', () => {
  it('a picked file sits in the tray and goes out as one scope with the line', async () => {
    const b = bridge();
    const thread = await mount();
    await attach(thread);
    expect(b.pickFile).toHaveBeenCalledWith({ purpose: 'scope_file' });
    expect(b.made).toEqual([]);
    await send(thread, '汇总一下', 1);
    expect(b.made).toEqual([{ files: [FILE] }]);
    expect(b.bodies).toEqual([{ text: '汇总一下', scope_id: 'scope-1' }]);
    expect(within(thread).queryByText(FILE.displayName)).toBeNull();
  });

  it('移除 takes the file out: no scope is made and the line has no scope_id', async () => {
    const b = bridge();
    const thread = await mount();
    await attach(thread);
    fireEvent.click(within(thread).getByRole('button', { name: `移除 ${FILE.displayName}` }));
    await send(thread, '不带了', 1);
    expect(b.made).toEqual([]);
    expect(b.bodies).toEqual([{ text: '不带了' }]);
  });

  it('no file picked: the body has no scope_id', async () => {
    const b = bridge();
    const thread = await mount();
    await send(thread, '你好', 1);
    expect(b.bodies).toEqual([{ text: '你好' }]);
  });

  it('这句不记 and a file exclude each other, and the line goes out with no_memory only', async () => {
    const b = bridge();
    const thread = await mount();
    fireEvent.click(within(thread).getByRole('button', { name: '附加' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '这句不记' }));
    expect(screen.getByRole('menuitem', { name: /^添加文件或图片/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await send(thread, '只说一次', 1);
    expect(b.bodies).toEqual([{ text: '只说一次', no_memory: true }]);
  });

  it('重试 sends the same scope_id again, without making another scope', async () => {
    const b = bridge();
    const thread = await mount();
    await attach(thread);
    const net = await send(thread, '汇总一下', 1);
    b.emit('agent_run', { run_id: 'run-1', phase: 'failed', conversation_id: C1, work_kind: 'foreground', error: 'network', code: 'network', retryable: true, public_message: '连接服务失败，请稍后重试。' });
    b.emit('line', { line_id: 'line-1', text_delta: '', final: true, conversation_id: C1, run_id: 'run-1', error: 'network', cancelled: false });
    fireEvent.click(await within(net).findByRole('button', { name: '重试' }));
    await waitFor(() => expect(thread.querySelector('[data-live="line-2"]')).toBeTruthy());
    expect(b.bodies).toEqual([{ text: '汇总一下', scope_id: 'scope-1' }, { text: '汇总一下', scope_id: 'scope-1' }]);
    expect(b.made).toHaveLength(1);
  });
});
