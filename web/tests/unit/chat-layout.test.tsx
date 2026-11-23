import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockRoute } from '../../src/mock';
import { MESSAGES, NOW, WIRE_CONVERSATIONS, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { MessageList } from '../../src/pages/chat/MessageList';
import { ChatPage } from '../../src/pages/chat/Page';
import { ToastHost } from '../../src/shell/toast';
import { C1, C2, C6 } from '../../src/mock/fixtures/ids';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

// The run state is in the header, the task opens in the right column (not a Sheet), tool rows and the
// inline task are the prototype's own rows, and an empty page offers 新建对话.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
});

/** A native-like bridge serving the mock routes plus `routes`; the clock reads the fixtures' NOW. */
function bridgeWith(routes: MockRoute[]) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true, routes });
}

const idle: MockRoute = { method: 'GET', path: '/conversations', handler: () => ({ status: 200, body: { conversations: WIRE_CONVERSATIONS, busy: false } }) };

async function mountChat(search: string) {
  const root = createRootRoute({ component: ChatPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: '消息' });
}

async function mountDefault() {
  const thread = await mountChat('');
  await within(thread).findByText('按项目分组，不要按日期。');
  return thread;
}

const list = (messages = MESSAGES[C1] ?? []) =>
  render(
    <MessageList
      messages={messages}
      view={null}
      roleName="示例乙"
      now={NOW}
      answered={{}}
      cancelled={{}}
      stopped={{}}
      frontTitle="整理本周提交周报"
      memsOf={() => ({ mems: [], learned: [] })}
      onOpenDrawer={() => {}}
      onAnswer={() => {}}
      onCancelQuestion={() => {}}
      onQueueSide={() => {}}
    />,
  ).container;

describe('chat: run state', () => {
  it('shows the header status and 停止, and no 前台 / 旁路 track in the thread', async () => {
    const thread = await mountDefault();
    expect(screen.getByText(/^执行中/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    expect(within(thread).queryByRole('group', { name: /^最近 10 分钟前台与旁路/ })).toBeNull();
  });

  it('shows no first-token or whole-turn readout under the speaker', async () => {
    const thread = await mountDefault();
    expect(thread.textContent).not.toContain('首字');
    expect(thread.textContent).not.toContain('整轮');
  });
});

describe('chat: the task opens in the right column', () => {
  it('is closed by default and opens from the inline task, closing with its 关闭 key', async () => {
    await mountDefault();
    expect(screen.queryByRole('complementary', { name: '任务' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^任务 整理本周提交周报/ }));
    const col = screen.getByRole('complementary', { name: '任务' });
    expect(within(col).getByRole('heading', { name: '整理本周提交周报' })).toBeTruthy();
    fireEvent.click(within(col).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('complementary', { name: '任务' })).toBeNull();
  });

  it('opens on the demos that show a task state', async () => {
    await mountChat('&demo=reject');
    expect(await screen.findByRole('complementary', { name: '任务' })).toBeTruthy();
  });
});

describe('chat: tool calls and the inline task', () => {
  // Turns carry no tool calls, so the stream component is checked with the fixture's tool messages.
  it('renders each tool call as a folded row with a duration bar; its output unfolds', () => {
    const thread = list();
    const rows = thread.querySelectorAll<HTMLElement>('[data-kind="tool"]');
    expect(rows).toHaveLength(3);
    const row = within(rows[0]!).getByRole('button', { expanded: false });
    expect(within(rows[0]!).getByRole('img', { name: /^耗时/ })).toBeTruthy();
    fireEvent.click(row);
    expect(rows[0]!.querySelector('[data-selectable]')).toBeTruthy();
  });

  // The run row carries no plan here, so the step cells stay out; the plan case is in chat-wiring.
  it('shows the inline task with its title, state and 查看任务', async () => {
    const thread = await mountDefault();
    const task = thread.querySelector<HTMLElement>('[data-kind="task"]');
    expect(task?.textContent).toMatch(/整理本周提交周报.*查看任务/);
  });
});

describe('chat: read-only side answers', () => {
  it('say 只读, link up to the foreground task and offer 派发任务', () => {
    const thread = list();
    const side = thread.querySelector<HTMLElement>('[data-kind="side"]')!;
    expect(within(side).getByText('只读')).toBeTruthy();
    expect(within(side).getByRole('button', { name: '↑ 触发时前台：整理本周提交周报' })).toBeTruthy();
    expect(within(side).getByRole('button', { name: /派发任务/ })).toBeTruthy();
    expect(side.textContent).not.toMatch(/排成任务/);
  });

  it('turns 派发任务 off with its reason when her character is not on the desktop', () => {
    const queued = vi.fn();
    const side = render(
      <MessageList messages={MESSAGES[C1] ?? []} view={null} roleName="示例乙" now={NOW} answered={{}} cancelled={{}} stopped={{}} frontTitle="整理本周提交周报" memsOf={() => ({ mems: [], learned: [] })} onOpenDrawer={() => {}} onAnswer={() => {}} onCancelQuestion={() => {}} onQueueSide={queued} queueOff="她不在桌面上" />,
    ).container.querySelector<HTMLElement>('[data-kind="side"]')!;
    const btn = within(side).getByRole('button', { name: /派发任务/ });
    fireEvent.click(btn);
    expect(queued).not.toHaveBeenCalled();
    expect(side.textContent).toContain('她不在桌面上');
  });
});

describe('chat: empty state', () => {
  it('says 还没有对话 once and offers 新建对话, without an input', async () => {
    const thread = await mountChat('&state=empty');
    expect(within(thread).getByText('还没有对话')).toBeTruthy();
    expect(screen.getAllByText(/还没有对话|暂无对话/)).toHaveLength(1);
    expect(screen.queryByRole('region', { name: '全部台词' })).toBeNull();
    expect(within(thread).getByRole('button', { name: /新建对话/ })).toBeTruthy();
    expect(within(thread).queryByRole('textbox', { name: '消息' })).toBeNull();
  });
});

describe('chat: kernel not ready', () => {
  it('names the kernel with its settings link and leaves the input on: agentd picks the route', async () => {
    const codex = WIRE_RUNTIME.installed_runtimes.find((r) => r.backend === 'codex')!;
    const loggedOut = { ...codex, authenticated: false };
    bridgeWith([
      {
        method: 'GET',
        path: '/character/runtime',
        handler: () => ({ status: 200, body: { ...WIRE_RUNTIME, ready: false, error: 'native_login_required', selected_runtime: loggedOut, installed_runtimes: [WIRE_RUNTIME.installed_runtimes[0], loggedOut] } }),
      },
    ]);
    const thread = await mountChat('&demo=kernel');
    const title = await within(thread).findByText('角色内核未就绪');
    const block = title.closest<HTMLElement>('[role="alert"]')!;
    expect(block.textContent).toContain('Codex 未就绪');
    expect(within(block).getByRole('link', { name: '设置 › 角色内核' }).getAttribute('href')).toBe('#/settings?group=kernel');
    expect((within(thread).getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('after a native_login_required send, 重新检测 in the no-model notice rereads with refresh=1', async () => {
    const codex = WIRE_RUNTIME.installed_runtimes.find((r) => r.backend === 'codex')!;
    const loggedOut = { ...codex, authenticated: false };
    let loggedIn = true;
    bridgeWith([
      idle,
      {
        method: 'GET',
        path: '/character/runtime',
        handler: () => ({ status: 200, body: loggedIn ? WIRE_RUNTIME : { ...WIRE_RUNTIME, ready: false, error: 'native_login_required', selected_runtime: loggedOut, installed_runtimes: [WIRE_RUNTIME.installed_runtimes[0], loggedOut] } }),
      },
      { method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 503, body: { error: 'native_login_required', runtime: 'codex' } }) },
    ]);
    const spy = vi.spyOn(window.agenticComplex!.agentd, 'request');
    const thread = await mountDefault();
    const input = within(thread).getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    loggedIn = false;
    fireEvent.change(input, { target: { value: '在吗' } });
    fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
    const notice = (await within(thread).findByText(/没有可用的模型/)).closest<HTMLElement>('[role="alert"]')!;
    expect(input.disabled).toBe(false);
    loggedIn = true;
    fireEvent.click(within(notice).getByRole('button', { name: '重新检测' }));
    await waitFor(() => expect(spy.mock.calls.some(([m, p]) => m === 'GET' && p === '/character/runtime?refresh=1')).toBe(true));
  });

  it('rereads an unready runtime when the window regains focus', async () => {
    const codex = WIRE_RUNTIME.installed_runtimes.find((r) => r.backend === 'codex')!;
    const loggedOut = { ...codex, authenticated: false };
    let loggedIn = false;
    bridgeWith([
      idle,
      {
        method: 'GET',
        path: '/character/runtime',
        handler: () => ({ status: 200, body: loggedIn ? WIRE_RUNTIME : { ...WIRE_RUNTIME, ready: false, error: 'native_login_required', selected_runtime: loggedOut, installed_runtimes: [WIRE_RUNTIME.installed_runtimes[0], loggedOut] } }),
      },
    ]);
    const thread = await mountDefault();
    await within(thread).findByText('角色内核未就绪');
    loggedIn = true;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(within(thread).queryByText('角色内核未就绪')).toBeNull());
    focusManager.setFocused(undefined);
  });

  it('rereads an unready runtime on its own, so a kernel that was still starting clears its notice', async () => {
    let started = false;
    bridgeWith([
      idle,
      { method: 'GET', path: '/character/runtime', handler: () => ({ status: 200, body: started ? WIRE_RUNTIME : { ...WIRE_RUNTIME, ready: false } }) },
    ]);
    const thread = await mountDefault();
    await within(thread).findByText('角色内核未就绪');
    started = true;
    await waitFor(() => expect(within(thread).queryByText('角色内核未就绪')).toBeNull(), { timeout: 5000 });
  }, 8000);

  const piRuntime = (error: string | null) => ({ ...WIRE_RUNTIME, backend: 'pi' as const, ready: false, error, selected_runtime: null });

  it('Pi without a model connection shows the no-model notice with its settings link', async () => {
    bridgeWith([idle, { method: 'GET', path: '/character/runtime', handler: () => ({ status: 200, body: piRuntime('pi_connection_missing') }) }]);
    const thread = await mountDefault();
    const notice = (await within(thread).findByText(/没有可用的模型/)).closest<HTMLElement>('[role="alert"]')!;
    expect(within(notice).getByRole('link', { name: '设置 › pi 账号与凭据' }).getAttribute('href')).toBe('#/settings?group=model');
    expect(within(thread).queryByText('Pi 未就绪')).toBeNull();
  });

  it('Pi not ready for another reason keeps the kernel block, without the no-model notice', async () => {
    bridgeWith([idle, { method: 'GET', path: '/character/runtime', handler: () => ({ status: 200, body: piRuntime(null) }) }]);
    const thread = await mountDefault();
    expect(await within(thread).findByText('Pi 未就绪')).toBeTruthy();
    expect(within(thread).queryByText(/没有可用的模型/)).toBeNull();
  });
});

describe('chat: conversation menu says no dev notes', () => {
  it('offers 重命名, which opens the title box in the row', async () => {
    await mountDefault();
    fireEvent.contextMenu(within(screen.getByRole('navigation', { name: '话题' })).getByText('周报整理').closest('button')!, { clientX: 40, clientY: 60 });
    const item = screen.getByRole('menuitem', { name: /重命名/ });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    expect(item.textContent).not.toContain('后台暂不提供');
    fireEvent.click(item);
    expect((screen.getByRole('textbox', { name: '话题名' }) as HTMLInputElement).value).toBe('周报整理');
  });

  it('opens an archived conversation by title, without its id', async () => {
    render(<ToastHost />);
    await mountDefault();
    fireEvent.click(screen.getByRole('button', { name: /已归档 3/ }));
    fireEvent.click(screen.getByText('九月旅行计划').closest('button')!);
    const thread = screen.getByRole('region', { name: '消息' });
    expect(await within(thread).findByText('已归档对话')).toBeTruthy();
    expect(within(thread).getByRole('button', { name: '恢复对话' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(new RegExp(`${C6}|mock|落点`));
  });
});

describe('chat: deleting a conversation', () => {
  it('confirms on a paper card', async () => {
    bridgeWith([idle]);
    const thread = await mountChat(`&demo=history&conv=${C2}`);
    await within(thread).findByText(/超时阈值是 1.5 s/);
    fireEvent.contextMenu(within(screen.getByRole('navigation', { name: '话题' })).getByText('HostLink 断线排查').closest('button')!, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }));
    const dlg = screen.getByRole('dialog', { name: '删除「HostLink 断线排查」？' });
    expect(dlg.textContent).not.toContain('//');
  });
});
