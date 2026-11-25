import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickedHandle } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockResponse, MockRoute } from '../../src/mock';
import { NOW, WIRE_CONVERSATIONS } from '../../src/mock/fixtures';
import { HANDOVER } from '../../src/mock/fixtures/chatDemo';
import { C1, C2 } from '../../src/mock/fixtures/ids';
import { createChatActions, type ChatDeps } from '../../src/pages/chat/actions';
import { ChatPage } from '../../src/pages/chat/Page';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

// The chat page's send flow: what stays in the input, what a late answer may touch, which topic a retry goes to.

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const FILE: PickedHandle = { handle: 'h-file', displayName: '销量.csv' };
const scope = (id: string) => ({ scope_id: id, revision: 1, roots: [], files: [], output: { path: '/x' }, created_at: 0, expires_at: 1, revoked: false });
const idleList: MockRoute = { method: 'GET', path: '/conversations', handler: () => ({ status: 200, body: { conversations: WIRE_CONVERSATIONS, busy: false } }) };

function bridge(routes: MockRoute[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const calls: Call[] = [];
  const switched: string[] = [];
  window.agenticComplex = {
    ...base,
    agentd: { ...base.agentd, request: (method, path, body) => (calls.push({ method, path, body }), base.agentd.request(method, path, body)) },
    character: { ...base.character, switchTo: (id) => (switched.push(id), base.character.switchTo(id)) },
    files: { ...base.files, pickFile: async () => FILE },
    feed: { subscribe: () => () => {} },
  };
  const of = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  return { calls, switched, of };
}

async function mount(search = '', ready: string | RegExp = '按项目分组，不要按日期。') {
  const root = createRootRoute({ component: ChatPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastHost />
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const thread = await screen.findByRole('region', { name: '消息' });
  await within(thread).findByText(ready);
  return thread;
}

const tab = (name: string) => within(screen.getByRole('tablist', { name: '角色' })).getByRole('tab', { name: new RegExp(`^${name}`) });
const topics = () => screen.getByRole('navigation', { name: '话题' });
const box = (thread: HTMLElement) => within(thread).getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const type = (thread: HTMLElement, text: string) => fireEvent.change(box(thread), { target: { value: text } });
const press = (thread: HTMLElement) => fireEvent.click(within(thread).getByRole('button', { name: '发送' }));
const flag = (thread: HTMLElement, name: string) => {
  fireEvent.click(within(thread).getByRole('button', { name: '附加' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name }));
};
const goToHer = async (thread: HTMLElement) => {
  fireEvent.click(tab('示例甲'));
  await within(thread).findByText('不急。看完告诉我一声就行。');
};

describe('a send to a character who is not on the desktop', () => {
  it('先不换 leaves the whole draft, and 这句不记 still goes out when she is brought out', async () => {
    const b = bridge();
    const thread = await mount();
    await goToHer(thread);
    flag(thread, '此轮不记录');
    type(thread, '我看完了');
    press(thread);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(box(thread).value).toBe('我看完了');
    expect(within(thread).getByRole('button', { name: '取消「此轮不记录」' })).toBeTruthy();
    press(thread);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '切换并发送' }));
    await waitFor(() => expect(b.of('POST', `/conversations/${HANDOVER}/messages`).map((c) => c.body)).toEqual([{ text: '我看完了', no_memory: true }]));
    await waitFor(() => expect(box(thread).value).toBe(''));
  });

  it('files are made into a scope only after the user agrees, and once', async () => {
    const made: unknown[] = [];
    const b = bridge([{ method: 'POST', path: '/agent/scopes', handler: ({ body }): MockResponse => (made.push(body), { status: 201, body: scope(`scope-${made.length}`) }) }]);
    const thread = await mount();
    await goToHer(thread);
    fireEvent.click(within(thread).getByRole('button', { name: '附加' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '添加文件或图片' }));
    await within(thread).findByText(FILE.displayName);
    type(thread, '汇总一下');
    press(thread);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(made).toEqual([]);
    expect(within(thread).getByText(FILE.displayName)).toBeTruthy();
    press(thread);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '切换并发送' }));
    await waitFor(() => expect(b.of('POST', `/conversations/${HANDOVER}/messages`).map((c) => c.body)).toEqual([{ text: '汇总一下', scope_id: 'scope-1' }]));
    expect(made).toEqual([{ files: [FILE] }]);
  });

  it('after the swap the optimistic reply is a front reply, not a side one', async () => {
    bridge();
    const thread = await mount();
    await goToHer(thread);
    type(thread, '我看完了');
    press(thread);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '切换并发送' }));
    await waitFor(() => expect(thread.querySelector('[data-live]')).toBeTruthy());
    expect(thread.querySelector('[data-live] [data-kind="side"]')).toBeNull();
  });
});

describe('what a late answer may touch', () => {
  it('a failed line is shown in its own topic only, and 重新发送 goes there', async () => {
    let release: () => void = () => {};
    let n = 0;
    const b = bridge([
      {
        method: 'POST',
        path: '/conversations/:id/messages',
        handler: () => (n++ === 0 ? new Promise<MockResponse>((r) => (release = () => r({ status: 503, body: { error: 'no_llm' } }))) : { status: 202, body: { line_id: 'line-2', generation: 1, run_id: 'run-2' } }),
      },
    ]);
    const thread = await mount();
    type(thread, '统计表好了吗？');
    press(thread);
    await waitFor(() => expect(b.of('POST', `/conversations/${C1}/messages`)).toHaveLength(1));
    await goToHer(thread);
    await act(async () => release());
    expect(within(thread).queryByText(/发送失败/)).toBeNull();
    fireEvent.click(tab('示例乙'));
    await within(thread).findByText(/发送失败/);
    fireEvent.click(within(thread).getByRole('button', { name: '重新发送' }));
    await waitFor(() => expect(b.of('POST', `/conversations/${C1}/messages`)).toHaveLength(2));
    expect(b.of('POST', `/conversations/${HANDOVER}/messages`)).toHaveLength(0);
  });

  const refused: MockRoute = { method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 503, body: { error: 'no_llm' } }) };

  it('a failed line outlives a failure in another topic', async () => {
    bridge([refused]);
    const thread = await mount();
    type(thread, '统计表好了吗？');
    press(thread);
    await within(thread).findByText(/发送失败/);
    await goToHer(thread);
    type(thread, '我看完了');
    press(thread);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '切换并发送' }));
    await within(thread).findByText('我看完了', { selector: 'span' });
    fireEvent.click(tab('示例乙'));
    await within(thread).findByText('统计表好了吗？', { selector: 'span' });
    expect(within(thread).getByRole('button', { name: '重新发送' })).toBeTruthy();
    fireEvent.click(within(thread).getByRole('button', { name: '放弃' }));
    await goToHer(thread);
    fireEvent.click(within(thread).getByRole('button', { name: '放弃' }));
    expect(within(thread).queryByText(/发送失败/)).toBeNull();
  });

  it('a failed line is still there after the page was left and opened again', async () => {
    bridge([refused]);
    let thread = await mount();
    type(thread, '统计表好了吗？');
    press(thread);
    await within(thread).findByText(/发送失败/);
    cleanup();
    thread = await mount();
    expect(within(thread).getByText('统计表好了吗？', { selector: 'span' })).toBeTruthy();
    fireEvent.click(within(thread).getByRole('button', { name: '放弃' }));
    expect(within(thread).queryByText(/发送失败/)).toBeNull();
  });
});

describe('opening topics', () => {
  it('the last topic clicked is the one that ends up active', async () => {
    let release: () => void = () => {};
    const activate: MockRoute = {
      method: 'POST',
      path: '/conversations/:id/activate',
      handler: ({ params }) => (params.id === C2 ? new Promise<MockResponse>((r) => (release = () => r({ status: 200, body: {} }))) : { status: 200, body: {} }),
    };
    const b = bridge([idleList, activate]);
    await mount();
    fireEvent.click(within(topics()).getByText('HostLink 断线排查'));
    await waitFor(() => expect(b.of('POST', `/conversations/${C2}/activate`)).toHaveLength(1));
    fireEvent.click(within(topics()).getByText('周报整理'));
    await act(async () => release());
    await waitFor(() => expect(b.of('POST', `/conversations/${C1}/activate`)).toHaveLength(1));
    const order = b.calls.filter((c) => c.path.endsWith('/activate')).map((c) => c.path);
    expect(order).toEqual([`/conversations/${C2}/activate`, `/conversations/${C1}/activate`]);
  });
});

describe('text and files put into the input from the page', () => {
  it('an example sentence goes in once and is not put back after the topic was left and reopened', async () => {
    bridge([
      { method: 'GET', path: '/conversations/:id/turns', handler: () => ({ status: 200, body: { turns: [], before: null } }) },
      { method: 'GET', path: '/agent/tasks', handler: () => ({ status: 200, body: { tasks: [], next_cursor: null } }) },
      { method: 'GET', path: '/agent/interactions', handler: () => ({ status: 200, body: { requests: [] } }) },
    ]);
    const root = createRootRoute({ component: ChatPage });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) })} />
      </QueryClientProvider>,
    );
    const thread = await screen.findByRole('region', { name: '消息' });
    fireEvent.click(await within(thread).findByRole('button', { name: '你能帮我做些什么？' }));
    expect(box(thread).value).toBe('你能帮我做些什么？');
    type(thread, '');
    fireEvent.click(tab('示例甲'));
    await within(thread).findByRole('textbox', { name: '消息' });
    fireEvent.click(tab('示例乙'));
    await within(thread).findByRole('textbox', { name: '消息' });
    expect(box(thread).value).toBe('');
  });

  it('a file dropped on a read-only topic is not taken', async () => {
    const adopted = vi.fn(async () => []);
    bridge([idleList]);
    window.agenticComplex = { ...window.agenticComplex!, files: { ...window.agenticComplex!.files, adoptDropped: adopted } };
    const thread = await mount(`&conv=${C2}`, /超时阈值是 1.5 s/);
    fireEvent.drop(thread, { dataTransfer: { files: [new File(['x'], '名单.xlsx')], types: ['Files'] } });
    await act(async () => {});
    fireEvent.click(within(topics()).getByText('周报整理'));
    await within(thread).findByText('按项目分组，不要按日期。');
    await within(thread).findByRole('textbox', { name: '消息' });
    expect(adopted).not.toHaveBeenCalled();
  });
});

describe('quoting', () => {
  const said = (): { bodies: unknown[]; route: MockRoute } => {
    const bodies: unknown[] = [];
    return { bodies, route: { method: 'POST', path: '/conversations/:id/messages', handler: ({ body }) => (bodies.push(body), { status: 202, body: { line_id: 'line-1', generation: 1, run_id: 'run-1' } }) } };
  };

  it('a quoted reply goes out as quote_turn with the plain text', async () => {
    const s = said();
    bridge([s.route]);
    const thread = await mount();
    fireEvent.contextMenu(within(thread).getByText(/^改好了：Companion/), { clientX: 10, clientY: 10 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '引用回复' }));
    type(thread, '好');
    press(thread);
    await waitFor(() => expect(s.bodies).toEqual([{ text: '好', quote_turn: { turn_id: 'tr7', part: 'reply' } }]));
  });

  it('a quoted line of the user goes out as part user', async () => {
    const s = said();
    bridge([s.route]);
    const thread = await mount();
    fireEvent.contextMenu(within(thread).getByText('按项目分组，不要按日期。'), { clientX: 10, clientY: 10 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '引用回复' }));
    type(thread, '好');
    press(thread);
    await waitFor(() => expect(s.bodies).toEqual([{ text: '好', quote_turn: { turn_id: 'tr7', part: 'user' } }]));
  });

  it('a history topic offers no 引用回复', async () => {
    bridge([idleList]);
    const thread = await mount(`&conv=${C2}`, /超时阈值是 1.5 s/);
    fireEvent.contextMenu(within(thread).getByText(/超时阈值是 1.5 s/), { clientX: 10, clientY: 10 });
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: '引用回复' })).toBeNull();
  });
});

describe('deliver', () => {
  async function deps(over: Partial<ChatDeps>, routes: MockRoute[]) {
    bridge(routes);
    const { fromConversation } = await import('../../src/domain');
    const replies: Array<Record<string, unknown>> = [];
    const failed: unknown[] = [];
    const d: ChatDeps = {
      conv: fromConversation(WIRE_CONVERSATIONS[0]!, NOW),
      character: 'si',
      present: 'si',
      askSwap: async () => true,
      shown: () => C1,
      task: null,
      run: null,
      view: null,
      busy: false,
      setLocal: () => {},
      setAnswered: () => {},
      setCancelled: () => {},
      setFailed: (f) => void failed.push(f),
      dropFailed: () => {},
      setSending: () => {},
      setBusyDecide: () => {},
      setNotice: () => {},
      select: () => {},
      editTitle: () => {},
      addReply: (r) => void replies.push(r),
      settleReply: () => {},
      reload: { list: () => {}, turns: () => {}, tasks: () => {}, present: () => {}, runtime: async () => undefined },
      push: () => {},
      failSend: false,
      ...over,
    };
    return { a: createChatActions(d), replies, failed };
  }
  const refuse: MockRoute = { method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 409, body: { error: 'character_not_present' } }) };

  it('asks for the swap once when agentd keeps saying she is not present', async () => {
    let asked = 0;
    const { a, failed } = await deps({ askSwap: async () => (asked++, true) }, [refuse]);
    const r = await a.send('在吗', { look: false, no_memory: false });
    expect(asked).toBe(1);
    expect(r).toBe('sent');
    expect(failed.some((f) => f != null)).toBe(true);
  });

  it('makes one conversation for a first line even when the swap card comes after the 409', async () => {
    let made = 0;
    const { a } = await deps({ conv: null }, [
      refuse,
      { method: 'POST', path: '/conversations', handler: () => (made++, { status: 201, body: { ...WIRE_CONVERSATIONS[0]!, id: 'new-conv' } }) },
    ]);
    await a.send('在吗', { look: false, no_memory: false });
    expect(made).toBe(1);
  });

  it('keeps the line when the swap card is declined', async () => {
    const { a } = await deps({ present: 'voice_a', askSwap: async () => false }, []);
    expect(await a.send('在吗', { look: false, no_memory: false })).toBe('kept');
  });

  it('a line that waits for the swap is not marked as a side reply', async () => {
    const { a, replies } = await deps({ present: 'voice_a', busy: true }, []);
    await a.send('在吗', { look: false, no_memory: false });
    expect(replies[0]!.side).toBe(false);
  });

  it('files that cannot be made into a scope come back as spent and no line is sent', async () => {
    const posted: unknown[] = [];
    const { a } = await deps({}, [
      { method: 'POST', path: '/agent/scopes', handler: () => ({ status: 409, body: { error: 'plugin_off' } }) },
      { method: 'POST', path: '/conversations/:id/messages', handler: ({ body }) => (posted.push(body), { status: 202, body: { line_id: 'l', generation: 1 } }) },
    ]);
    expect(await a.send('汇总', { look: false, no_memory: false, files: [FILE] })).toBe('spent');
    expect(posted).toEqual([]);
  });

  it('a failure remembers its topic and character', async () => {
    const { a, failed } = await deps({}, [{ method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 503, body: { error: 'no_llm' } }) }]);
    await a.send('在吗', { look: false, no_memory: false });
    expect(failed.at(-1)).toMatchObject({ text: '在吗', conv: C1, character: 'si' });
  });

  it('a resend goes to the topic the failed line was made in', async () => {
    const posted: string[] = [];
    const { a } = await deps({}, [{ method: 'POST', path: '/conversations/:id/messages', handler: ({ params }) => (posted.push(params.id ?? ''), { status: 202, body: { line_id: 'l', generation: 1 } }) }]);
    await a.resend('在吗', { look: false, no_memory: false }, { conv: HANDOVER, character: 'si' });
    expect(posted).toEqual([HANDOVER]);
  });

  it('sends quote_turn in the body', async () => {
    const posted: unknown[] = [];
    const { a } = await deps({}, [{ method: 'POST', path: '/conversations/:id/messages', handler: ({ body }) => (posted.push(body), { status: 202, body: { line_id: 'l', generation: 1 } }) }]);
    await a.send('好', { look: false, no_memory: false, quote_turn: { turn_id: 'tr7', part: 'reply' } });
    expect(posted).toEqual([{ text: '好', quote_turn: { turn_id: 'tr7', part: 'reply' } }]);
  });

  it('queueSide is refused for a character who is not on the desktop', async () => {
    const pushed: string[] = [];
    const { a } = await deps({ character: 'voice_a', push: (m) => void pushed.push(m) }, []);
    await a.queueSide('顺便查下');
    expect(pushed).toEqual(['未能派发任务：角色当前未在桌面显示']);
  });

  it('重新检测 judges by the chat and quick routes, not the main kernel', async () => {
    const pushed: string[] = [];
    const route = (ready: boolean) => ({ ready, follows_main: true, error: null });
    const runtime = (chat: boolean, quick: boolean) => async () => ({ wire: { routes: { chat: route(chat), quick: route(quick) } }, info: { ready: false, selected: 'codex', runtimes: [{ id: 'codex', name: 'Codex' }] } }) as never;
    const ready = await deps({ push: (m) => void pushed.push(m), reload: { list: () => {}, turns: () => {}, tasks: () => {}, present: () => {}, runtime: runtime(true, true) } }, []);
    await ready.a.recheck();
    const quickOff = await deps({ push: (m) => void pushed.push(m), reload: { list: () => {}, turns: () => {}, tasks: () => {}, present: () => {}, runtime: runtime(true, false) } }, []);
    await quickOff.a.recheck();
    expect(pushed).toEqual(['执行内核已就绪', '重新检测：快速回复仍未就绪']);
  });
});

describe('the page and agentd are told about the swap', () => {
  it('both characters’ topic lists are read again after she is brought out', async () => {
    const lists: string[] = [];
    const { a } = await (async () => {
      bridge();
      const { fromConversation } = await import('../../src/domain');
      const d: ChatDeps = {
        conv: fromConversation(WIRE_CONVERSATIONS[0]!, NOW), character: 'voice_a', present: 'si', askSwap: async () => true, shown: () => C1, task: null, run: null, view: null, busy: false,
        setLocal: () => {}, setAnswered: () => {}, setCancelled: () => {}, setFailed: () => {}, dropFailed: () => {}, setSending: () => {}, setBusyDecide: () => {}, setNotice: () => {}, select: () => {}, editTitle: () => {},
        addReply: () => {}, settleReply: () => {}, push: () => {}, failSend: false,
        reload: { list: () => void lists.push('list'), turns: () => {}, tasks: () => {}, present: () => void lists.push('present'), runtime: async () => undefined },
      };
      return { a: createChatActions(d) };
    })();
    await a.swap('voice_a', '示例甲');
    expect(lists).toEqual(['present', 'list']);
  });
});
