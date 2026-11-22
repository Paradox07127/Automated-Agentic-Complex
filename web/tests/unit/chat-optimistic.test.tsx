import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { fromConversation } from '../../src/domain';
import type { MockResponse, MockRoute } from '../../src/mock';
import { NOW, WIRE_CONVERSATIONS } from '../../src/mock/fixtures';
import { C1 } from '../../src/mock/fixtures/ids';
import { createChatActions, type ChatDeps } from '../../src/pages/chat/actions';
import { ChatPage } from '../../src/pages/chat/Page';
import type { LiveReply } from '../../src/pages/chat/useChatFeed';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
  window.location.hash = '';
});

/** A fake bridge whose n-th send waits until `reply(n, res)` answers it; `emit` plays a feed event. */
function bridge() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const held: Array<(res: MockResponse) => void> = [];
  const say: MockRoute = { method: 'POST', path: '/conversations/:id/messages', handler: () => new Promise<MockResponse>((resolve) => held.push(resolve)) };
  const base = createFakeBridge({ surface: 'main', still: true, routes: [say] });
  let onEvent: ((e: StreamEvent) => void) | null = null;
  window.agenticComplex = { ...base, feed: { subscribe: (e) => ((onEvent = e), () => {}) } };
  return {
    emit: (event: string, data: unknown) => act(() => onEvent?.({ event, id: null, data: JSON.stringify(data) })),
    reply: async (n: number, res: MockResponse) => {
      await waitFor(() => expect(held.length).toBeGreaterThanOrEqual(n));
      await act(async () => held[n - 1]!(res));
    },
  };
}

const accepted = (n: number): MockResponse => ({ status: 202, body: { line_id: `line-${n}`, generation: 43, run_id: `run-${n}`, runtime: 'codex' } });

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

function send(thread: HTMLElement, text: string) {
  fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: text } });
  fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
}

const live = (thread: HTMLElement) => [...thread.querySelectorAll<HTMLElement>('[data-live]')];

describe('a chat line shows the moment it is sent', () => {
  it('shows the line and 在想 before its 202, then the real line in the same node', async () => {
    const { reply } = bridge();
    const thread = await mount();
    send(thread, '先回显这句');
    const [row] = live(thread);
    expect(row).toBeTruthy();
    expect(within(row!).getByText('先回显这句')).toBeTruthy();
    expect(within(row!).getByText('在想')).toBeTruthy();

    await reply(1, accepted(1));
    await waitFor(() => expect(thread.querySelector('[data-live="line-1"]')).toBeTruthy());
    expect(live(thread)).toHaveLength(1);
    expect(thread.querySelector('[data-live="line-1"]')).toBe(row);
    expect(within(thread).getAllByText('先回显这句')).toHaveLength(1);
  });

  it('a failed send takes the line back out and keeps the send-failed notice', async () => {
    const { reply } = bridge();
    const thread = await mount();
    send(thread, '这句发不出去');
    expect(live(thread)).toHaveLength(1);

    await reply(1, { status: 503, body: { error: { code: 'unavailable', message: 'down' } } });
    expect(await within(thread).findByText(/发送失败/)).toBeTruthy();
    expect(live(thread)).toHaveLength(0);
  });

  it('retains chunks and final status when the event stream wins the race with the 202', async () => {
    const { emit, reply } = bridge();
    const thread = await mount();
    send(thread, '请先核对统计，再给结论');
    const [row] = live(thread);
    emit('line', { line_id: 'unrelated-line', text_delta: '另一个会话', final: true, conversation_id: 'other' });
    emit('line', { line_id: 'line-1', text_delta: '已经核对。', final: false, conversation_id: C1 });
    emit('line', { line_id: 'line-1', text_delta: '共三条。', final: true, conversation_id: C1, provider: 'openai', account_label: 'codex_login' });

    await reply(1, accepted(1));
    expect(live(thread)).toEqual([row]);
    expect(await within(row!).findByText('已经核对。共三条。')).toBeTruthy();
    expect(within(row!).queryByText(/在想|另一个会话/)).toBeNull();
  });

  it('在想 goes once the first line text arrives', async () => {
    const { emit, reply } = bridge();
    const thread = await mount();
    send(thread, '你好');
    await reply(1, accepted(1));
    const row = await waitFor(() => thread.querySelector<HTMLElement>('[data-live="line-1"]')!);
    expect(within(row).getByText('在想')).toBeTruthy();

    emit('line', { line_id: 'line-1', text_delta: '在这儿', final: false, conversation_id: C1, run_id: 'run-1' });
    expect(await within(row).findByText('在这儿')).toBeTruthy();
    expect(within(row).queryByText('在想')).toBeNull();
  });

  it('two quick lines each take their own 202', async () => {
    const { reply } = bridge();
    const rows: Array<Partial<LiveReply>> = [];
    const deps: ChatDeps = {
      conv: fromConversation(WIRE_CONVERSATIONS[0]!, NOW),
      character: 'si',
      present: 'si',
      askSwap: async () => true,
      shown: () => null,
      task: null,
      run: null,
      view: null,
      busy: false,
      setLocal: () => {},
      setAnswered: () => {},
      setCancelled: () => {},
      setFailed: () => {},
      setSending: () => {},
      setBusyDecide: () => {},
      setNotice: () => {},
      select: () => {},
      editTitle: () => {},
      addReply: (r) => void rows.push({ ...r }),
      settleReply: (id, r) => Object.assign(rows.find((x) => x.line_id === id)!, r),
      reload: { list: () => {}, turns: () => {}, tasks: () => {}, present: () => {}, runtime: async () => undefined },
      push: () => {},
      failSend: false,
    };
    const a = createChatActions(deps);
    const first = a.send('第一句');
    const second = a.send('第二句');
    expect(rows.map((r) => r.said)).toEqual(['第一句', '第二句']);
    expect(rows[0]!.line_id).not.toBe(rows[1]!.line_id);

    await reply(2, accepted(2));
    await reply(1, accepted(1));
    await Promise.all([first, second]);
    expect(rows.map((r) => [r.said, r.line_id, r.run_id])).toEqual([['第一句', 'line-1', 'run-1'], ['第二句', 'line-2', 'run-2']]);
  });
});
