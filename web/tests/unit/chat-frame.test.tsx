import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockRoute } from '../../src/mock';
import { NOW } from '../../src/mock/fixtures';
import { HANDOVER } from '../../src/mock/fixtures/chatDemo';
import { C1, C2 } from '../../src/mock/fixtures/ids';
import { ChatPage } from '../../src/pages/chat/Page';
import { ToastHost } from '../../src/shell/toast';
import { stubMatchMedia } from './mediaStub';
import { pluginsOn, pluginsReset } from './plugins';

// Chat v2 frame: character tabs in the header, her topics on the left, topic management by right click, the swap card.

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.agenticComplex;
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A native-like bridge over the mock routes plus `routes`, recording every agentd request and every switchTo. */
function bridge(routes: MockRoute[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const calls: Call[] = [];
  const switched: string[] = [];
  window.agenticComplex = {
    ...base,
    agentd: { ...base.agentd, request: (method, path, body) => (calls.push({ method, path, body }), base.agentd.request(method, path, body)) },
    character: { ...base.character, switchTo: (id, look) => (switched.push(id), base.character.switchTo(id, look)) },
    feed: { subscribe: () => () => {} },
  };
  const of = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  return { calls, switched, of };
}

async function mount(search = '') {
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
  await within(thread).findByText('按项目分组，不要按日期。');
  return thread;
}

const tabs = () => screen.getByRole('tablist', { name: '角色' });
const tab = (name: string) => within(tabs()).getByRole('tab', { name: new RegExp(`^${name}`) });
const topics = () => screen.getByRole('navigation', { name: '话题' });
const row = (title: string) => within(topics()).getByText(title).closest('button')!;
const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
const menuItem = (name: string | RegExp) => within(screen.getByRole('menu')).getByRole('menuitem', { name });
const send = (thread: HTMLElement, text: string) => {
  fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: text } });
  fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
};

describe('chat v2: character tabs', () => {
  it('lists the characters in the header, the one on the desktop marked, and her topics only', async () => {
    const b = bridge();
    await mount();
    expect(within(tabs()).getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['示例乙，在桌面', '示例甲', '示例丙']);
    expect(tab('示例乙').getAttribute('aria-selected')).toBe('true');
    expect(b.of('GET', '/conversations?character=si')).not.toHaveLength(0);
    expect(within(topics()).getByText('应龙特勤队见面会')).toBeTruthy();
    expect(within(topics()).queryByText('协议核心的交接')).toBeNull();
    fireEvent.click(tab('示例甲'));
    expect(await within(topics()).findByText('协议核心的交接')).toBeTruthy();
    expect(within(topics()).queryByText('周报整理')).toBeNull();
    expect(b.of('GET', '/conversations?character=voice_a')).not.toHaveLength(0);
    const thread = screen.getByRole('region', { name: '消息' });
    expect(await within(thread).findByText('不急。看完告诉我一声就行。')).toBeTruthy();
  });

  it('Q and E step through the tabs outside the input box', async () => {
    bridge();
    const thread = await mount();
    fireEvent.keyDown(document.body, { key: 'e' });
    await waitFor(() => expect(tab('示例甲').getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(await within(thread).findByRole('textbox', { name: '消息' }), { key: 'q' });
    expect(tab('示例甲').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'q' });
    await waitFor(() => expect(tab('示例乙').getAttribute('aria-selected')).toBe('true'));
  });

  it('a row shows its title, last line and time; the selected one is current, pinned rows first', async () => {
    bridge();
    await mount();
    const rows = [...topics().querySelectorAll<HTMLElement>('button[data-topic]')];
    expect(rows[0]!.textContent).toMatch(/^周报整理/);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    expect(row('HostLink 断线排查').textContent).toMatch(/日志里 11:38 心跳连续 3 次超时/);
    expect(row('HostLink 断线排查').textContent).toMatch(/11:40/);
    expect(within(topics()).getByRole('button', { name: '已归档 3' })).toBeTruthy();
  });

  it('opening another character’s topic activates it even though she is not on the desktop', async () => {
    const b = bridge();
    await mount();
    fireEvent.click(tab('示例甲'));
    fireEvent.click(await within(topics()).findByText('早班的提醒'));
    await waitFor(() => expect(b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/activate'))).toHaveLength(1));
    fireEvent.click(tab('示例乙'));
    expect(await within(screen.getByRole('region', { name: '消息' })).findByText('按项目分组，不要按日期。')).toBeTruthy();
    fireEvent.click(tab('示例甲'));
    expect(await within(screen.getByRole('region', { name: '消息' })).findByText('早。今天九点有站会，别忘了。')).toBeTruthy();
  });
});

describe('chat v2: the topic column folds', () => {
  it('folds by itself at 1000 px or narrower and stays open once the user opens it', async () => {
    const media = stubMatchMedia(new Set(['(max-width: 1000px)']));
    bridge();
    await mount();
    const fold = () => within(topics()).getByRole('button', { name: /左栏$/ });
    expect(fold().getAttribute('aria-label')).toBe('展开左栏');
    expect(within(topics()).queryByRole('textbox', { name: '搜索话题' })).toBeNull();
    fireEvent.click(fold());
    expect(fold().getAttribute('aria-label')).toBe('折叠左栏');
    media.set('(max-width: 1000px)', false);
    media.set('(max-width: 1000px)', true);
    expect(fold().getAttribute('aria-label')).toBe('折叠左栏');
    fireEvent.click(fold());
    expect(fold().getAttribute('aria-label')).toBe('展开左栏');
  });

  it('is open on a wide window', async () => {
    stubMatchMedia();
    bridge();
    await mount();
    expect(within(topics()).getByRole('button', { name: '折叠左栏' })).toBeTruthy();
    expect(within(topics()).getByRole('textbox', { name: '搜索话题' })).toBeTruthy();
  });
});

describe('chat v2: topic management', () => {
  it('renames in the row: Enter saves, Esc leaves the title', async () => {
    const b = bridge();
    await mount();
    rightClick(row('HostLink 断线排查'));
    fireEvent.click(menuItem(/重命名/));
    const input = within(topics()).getByRole('textbox', { name: '话题名' }) as HTMLInputElement;
    expect(input.value).toBe('HostLink 断线排查');
    fireEvent.change(input, { target: { value: 'HostLink 心跳' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(topics()).queryByRole('textbox', { name: '话题名' })).toBeNull();
    expect(b.of('PUT', `/conversations/${C2}`)).toHaveLength(0);
    rightClick(row('HostLink 断线排查'));
    fireEvent.click(menuItem(/重命名/));
    fireEvent.change(within(topics()).getByRole('textbox', { name: '话题名' }), { target: { value: 'HostLink 心跳' } });
    fireEvent.keyDown(within(topics()).getByRole('textbox', { name: '话题名' }), { key: 'Enter' });
    await waitFor(() => expect(b.of('PUT', `/conversations/${C2}`).map((c) => c.body)).toEqual([{ expected_version: 2, title: 'HostLink 心跳' }]));
    expect(await within(topics()).findByText('HostLink 心跳')).toBeTruthy();
  });

  it('a new topic of the selected character starts in its rename box', async () => {
    const b = bridge();
    await mount();
    fireEvent.click(tab('示例甲'));
    await within(topics()).findByText('协议核心的交接');
    fireEvent.click(within(topics()).getAllByRole('button', { name: '新话题' }).at(-1)!);
    await waitFor(() => expect(b.of('POST', '/conversations').map((c) => c.body)).toEqual([{ character_id: 'voice_a' }]));
    const input = (await within(topics()).findByRole('textbox', { name: '话题名' })) as HTMLInputElement;
    expect(input.value).toBe('新对话');
  });

  it('F2 opens the rename box on the selected row', async () => {
    bridge();
    await mount();
    fireEvent.keyDown(row('周报整理'), { key: 'F2' });
    expect((within(topics()).getByRole('textbox', { name: '话题名' }) as HTMLInputElement).value).toBe('周报整理');
  });

  it('archives a topic into 已归档 and restores it from there', async () => {
    const b = bridge();
    await mount();
    rightClick(row('十月开销汇总'));
    fireEvent.click(menuItem('归档'));
    expect(await within(topics()).findByRole('button', { name: '已归档 4' })).toBeTruthy();
    expect(within(topics()).queryByText('十月开销汇总')).toBeNull();
    fireEvent.click(within(topics()).getByRole('button', { name: '已归档 4' }));
    rightClick(row('十月开销汇总'));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: '归档' })).toBeNull();
    fireEvent.click(menuItem('恢复'));
    expect(await within(topics()).findByRole('button', { name: '已归档 3' })).toBeTruthy();
    expect(b.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { expected_version: 1, archived: true },
      { expected_version: 2, archived: false },
    ]);
  });

  it('删除… asks on a paper card: 先不删, 改成归档 or 删除, saying how many turns go', async () => {
    const b = bridge();
    await mount();
    fireEvent.click(tab('示例甲'));
    rightClick(await within(topics()).findByText('早班的提醒'));
    fireEvent.click(menuItem(/删除/));
    let card = screen.getByRole('dialog', { name: '删除「早班的提醒」？' });
    expect(card.textContent).toMatch(/1 轮对话/);
    fireEvent.click(within(card).getByRole('button', { name: '先不删' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    rightClick(row('早班的提醒'));
    fireEvent.click(menuItem(/删除/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '改成归档' }));
    await waitFor(() => expect(b.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ expected_version: 1, archived: true }]));
    fireEvent.keyDown(row('协议核心的交接'), { key: 'Delete' });
    card = screen.getByRole('dialog', { name: '删除「协议核心的交接」？' });
    expect(card.textContent).toMatch(/2 轮对话/);
    fireEvent.click(within(card).getByRole('button', { name: /^删除/ }));
    await waitFor(() => expect(b.of('DELETE', `/conversations/${HANDOVER}`).map((c) => c.body)).toEqual([{ expected_version: 1 }]));
    await waitFor(() => expect(within(topics()).queryByText('协议核心的交接')).toBeNull());
  });

  it('the right-click menu closes when another topic opens', async () => {
    bridge();
    await mount();
    rightClick(row('HostLink 断线排查'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(row('十月开销汇总'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('a tab’s right click offers a new topic, bringing her out and her own memories', async () => {
    bridge();
    await mount();
    rightClick(tab('示例甲'));
    const menu = screen.getByRole('menu', { name: '示例甲' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['新话题', '换示例甲出来', '她的专属记忆']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('chat v2: a character not on the desktop', () => {
  it('sending asks to bring her out, switches to her, waits for /state and then sends', async () => {
    const b = bridge();
    const thread = await mount();
    fireEvent.click(tab('示例甲'));
    await within(thread).findByText('不急。看完告诉我一声就行。');
    send(thread, '我看完了');
    const card = await screen.findByRole('dialog', { name: '换示例甲出来回你？' });
    expect(b.of('POST', `/conversations/${HANDOVER}/messages`)).toHaveLength(0);
    fireEvent.click(within(card).getByRole('button', { name: '换出来并发送' }));
    await waitFor(() => expect(b.of('POST', `/conversations/${HANDOVER}/messages`).map((c) => c.body)).toEqual([{ text: '我看完了' }]));
    expect(b.switched).toEqual(['voice_a']);
    const sent = b.calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/messages'));
    expect(b.calls.slice(0, sent).some((c) => c.path === '/state')).toBe(true);
    await waitFor(() => expect(tab('示例甲').getAttribute('aria-label')).toBe('示例甲，在桌面'));
  });

  it('先不换 sends nothing and keeps the text in the input', async () => {
    const b = bridge();
    const thread = await mount();
    fireEvent.click(tab('示例甲'));
    await within(thread).findByText('不急。看完告诉我一声就行。');
    send(thread, '我看完了');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '先不换' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((within(thread).getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('我看完了');
    expect(b.switched).toEqual([]);
  });

  it('a 409 character_not_present shows the card again', async () => {
    const refused: MockRoute = { method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 409, body: { error: 'character_not_present', character_id: 'voice_a' } }) };
    const b = bridge([refused]);
    const thread = await mount();
    send(thread, '在吗');
    const card = await screen.findByRole('dialog', { name: '换示例乙出来回你？' });
    expect(b.of('POST', `/conversations/${C1}/messages`)).toHaveLength(1);
    expect(within(card).getByRole('button', { name: '换出来并发送' })).toBeTruthy();
  });
});

describe('chat v2: no trace on the chat page', () => {
  it('has no turn inspector, turn tags, track or history button, even with a turn in the URL', async () => {
    bridge();
    const thread = await mount('&turn=tr7');
    expect(screen.queryByRole('complementary', { name: '轮次详情' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '轮次详情' })).toBeNull();
    expect(within(thread).queryAllByRole('button', { name: /打开轮次详情$/ })).toHaveLength(0);
    expect(within(thread).queryByRole('group', { name: /^最近 10 分钟前台与旁路/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '历史记录' })).toBeNull();
    expect(screen.queryByRole('button', { name: '管理对话' })).toBeNull();
    expect(screen.getByText(/^执行中/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
  });

  it('the dialog header names the topic only', async () => {
    bridge();
    const thread = await mount();
    const head = thread.querySelector<HTMLElement>('[data-g="head"]')!;
    expect(head.textContent).toBe('周报整理');
  });
});

describe('chat v2: quoting a message', () => {
  it('引用回复 puts the line above the input, and the sent line carries its turn instead of > lines', async () => {
    const accept: MockRoute = { method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 202, body: { line_id: 'line-1', generation: 1, run_id: 'run-1' } }) };
    const b = bridge([accept]);
    const thread = await mount();
    fireEvent.contextMenu(within(thread).getByText('按项目分组，不要按日期。'), { clientX: 10, clientY: 10 });
    fireEvent.click(menuItem('引用回复'));
    expect(within(thread).getByRole('button', { name: '不引用' })).toBeTruthy();
    send(thread, '好');
    await waitFor(() => expect(b.of('POST', `/conversations/${C1}/messages`).map((c) => c.body)).toEqual([{ text: '好', quote_turn: { turn_id: 'tr7', part: 'user' } }]));
    await waitFor(() => expect(within(thread).queryByRole('button', { name: '不引用' })).toBeNull());
  });
});
