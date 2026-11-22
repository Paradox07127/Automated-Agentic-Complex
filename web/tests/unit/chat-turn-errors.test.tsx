import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockRoute } from '../../src/mock';
import { NOW } from '../../src/mock/fixtures';
import { C1 } from '../../src/mock/fixtures/ids';
import { ChatPage } from '../../src/pages/chat/Page';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
  window.location.hash = '';
});

/** A fake bridge whose sends answer `line-n` / `run-n`; `emit` plays a feed event. */
/** The bodies of the lines sent, in order. */
let bodies: unknown[] = [];

function bridge() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  let n = 0;
  bodies = [];
  const say: MockRoute = { method: 'POST', path: '/conversations/:id/messages', handler: ({ body }) => (++n, bodies.push(body), { status: 202, body: { line_id: `line-${n}`, generation: 43, run_id: `run-${n}`, runtime: 'codex' } }) };
  const base = createFakeBridge({ surface: 'main', still: true, routes: [say] });
  let onEvent: ((e: StreamEvent) => void) | null = null;
  window.agenticComplex = { ...base, feed: { subscribe: (e) => ((onEvent = e), () => {}) } };
  return (event: string, data: unknown) => act(() => onEvent?.({ event, id: null, data: JSON.stringify(data) }));
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

/** The run's failed `agent_run` (classify_failure() fields), then the line's final with its error. */
function fail(emit: ReturnType<typeof bridge>, n: number, error: string, failure: { code: string; retryable: boolean; public_message: string }) {
  emit('agent_run', { run_id: `run-${n}`, phase: 'failed', conversation_id: C1, work_kind: 'foreground', error, ...failure });
  emit('line', { line_id: `line-${n}`, text_delta: '', final: true, conversation_id: C1, run_id: `run-${n}`, error, cancelled: false });
}

describe('a failed chat turn says why and what to do next', () => {
  it('auth_expired, quota_exhausted and network each show their reason and the matching control', async () => {
    const emit = bridge();
    const thread = await mount();
    const auth = await send(thread, '第一句', 1);
    fail(emit, 1, 'auth_expired', { code: 'auth_expired', retryable: false, public_message: '登录已过期，请重新登录。' });
    const quota = await send(thread, '第二句', 2);
    fail(emit, 2, 'quota_exhausted', { code: 'quota_exhausted', retryable: false, public_message: '可用额度已用完，请检查账户额度。' });
    const net = await send(thread, '第三句', 3);
    fail(emit, 3, 'network', { code: 'network', retryable: true, public_message: '连接服务失败，请稍后重试。' });

    expect(await within(auth).findByText(/登录已过期，请重新登录/)).toBeTruthy();
    expect(within(quota).getByText(/可用额度已用完，请检查账户额度/)).toBeTruthy();
    expect(within(net).getByText(/连接服务失败，请稍后重试/)).toBeTruthy();
    for (const row of [auth, quota, net]) expect(within(row).queryByText(/没有回复/)).toBeNull();

    expect(within(quota).queryByRole('button', { name: '去登录' })).toBeNull();
    expect(within(net).queryByRole('button', { name: '去登录' })).toBeNull();
    expect(within(net).queryByRole('button', { name: '查看用量' })).toBeNull();
    fireEvent.click(within(auth).getByRole('button', { name: '去登录' }));
    expect(window.location.hash).toContain('/settings?group=kernel');
    fireEvent.click(within(quota).getByRole('button', { name: '查看用量' }));
    expect(window.location.hash).toContain('/diag?item=usage');
  });

  it('a kernel code from the line has its own sentence', async () => {
    const emit = bridge();
    const thread = await mount();
    const row = await send(thread, '你好', 1);
    fail(emit, 1, 'bundled_cli_missing', { code: 'unknown', retryable: false, public_message: '本次请求失败，请稍后再试。' });
    expect(await within(row).findByText(/应用自带的内核文件不全/)).toBeTruthy();
  });

  it('an unknown code shows the backend public_message', async () => {
    const emit = bridge();
    const thread = await mount();
    const row = await send(thread, '你好', 1);
    fail(emit, 1, 'agent_run_failed', { code: 'unknown', retryable: false, public_message: '本次请求失败，请稍后再试。' });
    expect(await within(row).findByText(/本次请求失败，请稍后再试。/)).toBeTruthy();
  });

  it('a retryable failure offers 重试, which sends the same line again', async () => {
    const emit = bridge();
    const thread = await mount();
    const auth = await send(thread, '第一句', 1);
    fail(emit, 1, 'auth_expired', { code: 'auth_expired', retryable: false, public_message: '登录已过期，请重新登录。' });
    const net = await send(thread, '第二句', 2);
    fail(emit, 2, 'network', { code: 'network', retryable: true, public_message: '连接服务失败，请稍后重试。' });
    fireEvent.click(await within(net).findByRole('button', { name: '重试' }));
    await waitFor(() => expect(thread.querySelector('[data-live="line-3"]')).toBeTruthy());
    expect(within(thread.querySelector<HTMLElement>('[data-live="line-3"]')!).getByText('第二句')).toBeTruthy();
    expect(within(auth).queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('重试 keeps the line out of the record when the first try was', async () => {
    const emit = bridge();
    const thread = await mount();
    fireEvent.click(within(thread).getByRole('button', { name: '附加' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '这句不记' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    const net = await send(thread, '只说一次', 1);
    fail(emit, 1, 'network', { code: 'network', retryable: true, public_message: '连接服务失败，请稍后重试。' });
    fireEvent.click(await within(net).findByRole('button', { name: '重试' }));
    await waitFor(() => expect(thread.querySelector('[data-live="line-2"]')).toBeTruthy());
    expect(bodies).toEqual([{ text: '只说一次', no_memory: true }, { text: '只说一次', no_memory: true }]);
  });

  it('a cancelled turn still reads 已取消', async () => {
    const emit = bridge();
    const thread = await mount();
    const row = await send(thread, '你好', 1);
    emit('agent_run', { run_id: 'run-1', phase: 'cancelled', conversation_id: C1, work_kind: 'foreground', error: 'user_cancelled', code: 'unknown', retryable: false, public_message: '本次请求失败，请稍后再试。' });
    emit('line', { line_id: 'line-1', text_delta: '', final: true, conversation_id: C1, run_id: 'run-1', error: 'user_cancelled', cancelled: true });
    expect(await within(row).findByText('■ 已取消')).toBeTruthy();
    expect(within(row).queryByText(/本次请求失败/)).toBeNull();
  });
});

describe('chat: no history dialog', () => {
  it('never reads /history, not even when a line of this conversation ends', async () => {
    const emit = bridge();
    const spy = vi.spyOn(window.agenticComplex!.agentd, 'request');
    await mount();
    expect(screen.queryByRole('button', { name: '历史记录' })).toBeNull();
    emit('line', { line_id: 'job-report-1', text_delta: '', final: true, conversation_id: C1 });
    await waitFor(() => expect(spy.mock.calls.some(([m, p]) => m === 'GET' && p.startsWith('/conversations/') && p.includes('/turns'))).toBe(true));
    expect(spy.mock.calls.filter(([m, p]) => m === 'GET' && p.startsWith('/history')).length).toBe(0);
  });
});
