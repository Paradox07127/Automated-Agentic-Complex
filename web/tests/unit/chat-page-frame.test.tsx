import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarState } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockRoute } from '../../src/mock';
import { NOW } from '../../src/mock/fixtures';
import { HANDOVER } from '../../src/mock/fixtures/chatDemo';
import { ChatPage } from '../../src/pages/chat/Page';
import { ToastHost } from '../../src/shell/toast';
import { stubMatchMedia } from './mediaStub';
import { pluginsOn, pluginsReset } from './plugins';

// The chat page's frame: deep links, the end states of the roster, the topic column, the character tabs, the cards.

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.getElementById('ef-modal-root')?.remove();
  delete window.agenticComplex;
  window.location.hash = '';
});

function bridge(routes: MockRoute[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const pushed: { state: ((s: AvatarState) => void) | null } = { state: null };
  window.agenticComplex = {
    ...base,
    avatar: { ...base.avatar, onState: (cb) => ((pushed.state = cb), () => {}) },
    feed: { subscribe: () => () => {} },
  };
  return pushed;
}

function mountPage(search = '') {
  const root = createRootRoute({ component: ChatPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastHost />
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

async function mount(search = '', ready: string | RegExp = '按项目分组，不要按日期。') {
  const client = mountPage(search);
  const thread = await screen.findByRole('region', { name: '消息' });
  await within(thread).findByText(ready);
  return { thread, client };
}

const tab = (name: string) => within(screen.getByRole('tablist', { name: '角色' })).getByRole('tab', { name: new RegExp(`^${name}`) });
const topics = () => screen.getByRole('navigation', { name: '话题' });
const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });

describe('a link into the chat', () => {
  it('?conv= of another character opens her tab and that topic', async () => {
    bridge();
    await mount(`&conv=${HANDOVER}`, '不急。看完告诉我一声就行。');
    expect(tab('示例甲').getAttribute('aria-selected')).toBe('true');
    expect(within(topics()).getByText('协议核心的交接').closest('button')!.getAttribute('aria-current')).toBe('true');
  });

  it('?turn= marks that reply and rests the stream on it, not at the bottom', async () => {
    const mark = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this.hasAttribute('data-sel') ? 500 : 0 } as DOMRect;
    });
    bridge();
    const { thread } = await mount(`&conv=${HANDOVER}&turn=turn-va-701`, '交接清单我放在共享目录了，你有空过一眼。');
    const reply = thread.querySelector('[data-kind="ai"][data-sel]');
    expect(reply?.textContent).toContain('交接清单');
    expect(thread.querySelector('[data-kind="ai"]:not([data-sel])')?.textContent).toContain('不急');
    await waitFor(() => expect(thread.querySelector<HTMLElement>('[data-g="messages"]')!.scrollTop).toBe(500));
    mark.mockRestore();
  });
});

describe('no character to show', () => {
  const noState = (calls: { lists: number }) => {
    const base = window.agenticComplex!;
    window.agenticComplex = {
      ...base,
      character: { ...base.character, list: async () => (calls.lists++, []) },
      agentd: { ...base.agentd, request: (async (method: string, path: string, body?: unknown) => (path === '/state' ? { status: 200, body: { character: null } } : base.agentd.request(method as never, path, body))) as never },
    };
  };

  it('an empty roster ends in a message with import and retry, not a skeleton', async () => {
    bridge();
    const calls = { lists: 0 };
    noState(calls);
    mountPage();
    expect(await screen.findByText('还没有角色')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去角色页导入' }));
    expect(window.location.hash).toMatch(/\/character\?.*pane=import/);
    const before = calls.lists;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(calls.lists).toBeGreaterThan(before));
  });

  it('unreadable character reads end in an error with retry and the import link', async () => {
    bridge();
    const base = window.agenticComplex!;
    let lists = 0;
    window.agenticComplex = {
      ...base,
      character: { ...base.character, list: async () => Promise.reject((lists++, new Error('down'))) },
      agentd: { ...base.agentd, request: (async () => ({ status: 500, body: null })) as never },
    };
    mountPage();
    expect(await screen.findByText(/读取角色失败/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '去角色页导入' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(lists).toBeGreaterThan(1));
  });
});

describe('the topic column and the tabs', () => {
  it('a new topic opens its rename box although the column was folded', async () => {
    stubMatchMedia(new Set(['(max-width: 1000px)']));
    bridge();
    const { thread } = await mount();
    fireEvent.click(tab('示例甲'));
    await within(thread).findByText('不急。看完告诉我一声就行。');
    expect(within(topics()).queryByRole('textbox', { name: '话题名' })).toBeNull();
    fireEvent.click(within(topics()).getByRole('button', { name: '新话题' }));
    expect(await within(topics()).findByRole('textbox', { name: '话题名' })).toBeTruthy();
  });

  it('a new topic clears a search that would hide it', async () => {
    stubMatchMedia();
    bridge();
    const { thread } = await mount();
    fireEvent.click(tab('示例甲'));
    await within(thread).findByText('不急。看完告诉我一声就行。');
    fireEvent.change(within(topics()).getByRole('textbox', { name: '搜索话题' }), { target: { value: '早班' } });
    fireEvent.click(within(topics()).getAllByRole('button', { name: '新话题' })[0]!);
    expect(await within(topics()).findByRole('textbox', { name: '话题名' })).toBeTruthy();
    expect((within(topics()).getByRole('textbox', { name: '搜索话题' }) as HTMLInputElement).value).toBe('');
  });

  it('示例甲的专属记忆 opens the memory page for that character', async () => {
    bridge();
    await mount();
    rightClick(tab('示例甲'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '示例甲的专属记忆' }));
    expect(window.location.hash).toMatch(/\/memory\?.*owner=voice_a/);
  });

  it('新话题 in the menu of the character on the desktop is off while she works, and on for the others', async () => {
    bridge();
    await mount();
    rightClick(tab('示例乙'));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /新话题/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    rightClick(tab('示例甲'));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /新话题/ }).getAttribute('aria-disabled')).toBeNull();
  });

  it('the character on the desktop follows the avatar’s pushed state', async () => {
    const pushed = bridge();
    await mount();
    expect(tab('示例乙').getAttribute('aria-label')).toBe('示例乙，在桌面');
    act(() => pushed.state?.({ running: true, visible: true, scale: 1, clickThroughAll: false, speaking: false, characterId: 'voice_a', appearanceId: null }));
    await waitFor(() => expect(tab('示例甲').getAttribute('aria-label')).toBe('示例甲，在桌面'));
  });

  it('a character imported on the character page shows as a tab here', async () => {
    bridge();
    const { client } = await mount();
    const list = (await window.agenticComplex!.character.list()).slice();
    act(() => client.setQueryData(['character', 'list'], [...list, { ...list[0]!, id: 'newcomer', name: '新来的', active: false }]));
    expect(await within(screen.getByRole('tablist', { name: '角色' })).findByRole('tab', { name: /^新来的/ })).toBeTruthy();
  });
});

describe('the cards cover the whole window', () => {
  it('the delete card and the swap card sit in the shell’s modal layer', async () => {
    const root = document.createElement('div');
    root.id = 'ef-modal-root';
    document.body.append(root);
    bridge();
    const { thread } = await mount();
    fireEvent.click(tab('示例甲'));
    await within(thread).findByText('不急。看完告诉我一声就行。');
    rightClick((await within(topics()).findByText('早班的提醒')).closest('button')!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /删除/ }));
    const del = await screen.findByRole('dialog', { name: /删除/ });
    expect(root.contains(del)).toBe(true);
    fireEvent.click(within(del).getByRole('button', { name: '先不删' }));
    fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: '我看完了' } });
    fireEvent.click(within(thread).getByRole('button', { name: '发送' }));
    const swap = await screen.findByRole('dialog', { name: /出来回你/ });
    expect(root.contains(swap)).toBe(true);
  });
});
