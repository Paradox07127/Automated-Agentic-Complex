// A page or block whose plug-in is off stays listed and on screen as 已关闭; a lost 后台 reads 未接入.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { ChatGate } from '../../src/pages/chat/Gate';
import { HomePage } from '../../src/pages/home/Page';
import { OverviewGate } from '../../src/pages/overview/Gate';
import { OverviewPage } from '../../src/pages/overview/Page';
import { TasksGate } from '../../src/pages/tasks/Gate';
import { TasksPage } from '../../src/pages/tasks/Page';
import { paletteItems } from '../../src/shell/CmdPalette.data';
import { HeaderSlotContext, type HeaderSlotValue } from '../../src/shell/headerSlot';
import { DEFAULT_PLUGINS, setPlugins } from '../../src/shell/plugins';
import { visibleRoutes } from '../../src/shell/registry';
import { Menu } from '../../src/ui';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  localStorage.clear();
  pluginsReset();
  window.location.hash = '';
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
  localStorage.clear();
  window.location.hash = '';
});

const hashQuery = () => new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1));

/** The shell's header and bottom-bar slots, so a page's portalled tabs and buttons land where a test can look. */
function Shell({ Page }: { Page: ComponentType }) {
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null);
  const [right, setRight] = useState<HTMLDivElement | null>(null);
  const [action, setAction] = useState<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null);
  const slot: HeaderSlotValue = { setSub: () => {}, tabs, right, action, bottom };
  return (
    <HeaderSlotContext.Provider value={slot}>
      <div ref={setTabs} data-testid="slot-tabs" />
      <div ref={setRight} data-testid="slot-right" />
      <div ref={setAction} data-testid="slot-action" />
      <div ref={setBottom} data-testid="slot-bottom" />
      <Page />
    </HeaderSlotContext.Provider>
  );
}

function mount(Page: ComponentType, search = '') {
  const root = createRootRoute({ component: () => <Shell Page={Page} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const slotsEmpty = () => ['tabs', 'right', 'action', 'bottom'].every((s) => screen.getByTestId(`slot-${s}`).childElementCount === 0);

describe('menus, ⌘K and the hotkeys', () => {
  it('list a plug-in page while its plug-in is off; developer pages still wait for 开发者模式', () => {
    const ids = visibleRoutes(false).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['overview', 'tasks']));
    for (const id of ['diag', 'pipeline']) expect(ids).not.toContain(id);
  });

  it('⌘K lists the off page marked 已关闭 and still opens it; 屏幕识读 and 重新检测内核 are there, off with their reason', () => {
    const items = paletteItems('', visibleRoutes(false), undefined, {}, {}, DEFAULT_PLUGINS);
    const page = items.find((i) => i.key === 'page-overview')!;
    expect(page.hint).toBe('已关闭');
    expect(page.run).toEqual({ kind: 'nav', target: { page: 'overview' } });
    expect(items.find((i) => i.key === 'look')?.run).toEqual({ kind: 'off', reason: '已关闭：请在设置中开启「屏幕识读」' });
    expect(items.find((i) => i.key === 'recheck')?.run).toEqual({ kind: 'off', reason: '已关闭：请在设置中开启「外部执行内核接入（Codex / Claude Code / ACP）」' });
    const all = { ...DEFAULT_PLUGINS, daily_brief: true, screen_reading: true, harness_bridge: true };
    const on = paletteItems('', visibleRoutes(false), undefined, {}, {}, all);
    expect(on.find((i) => i.key === 'page-overview')?.hint).toBe('');
    expect(on.find((i) => i.key === 'look')?.run.kind).toBe('desktop');
  });

  it('a menu item marked off shows 已关闭 with its reason and can still be chosen', () => {
    const onSelect = vi.fn();
    render(<Menu label="页面" open items={[{ kind: 'item', label: '每日简报', off: '已关闭：设置里关着「每日简报」', onSelect }]} />);
    const item = screen.getByRole('menuitem', { name: '每日简报' });
    expect(item.getAttribute('aria-disabled')).toBeNull();
    expect(item.getAttribute('aria-description')).toBe('已关闭：设置里关着「每日简报」');
    expect(item.querySelector('[data-off]')).not.toBeNull();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('每日简报 off', () => {
  it('greys the page under a 已关闭 board leading to its switch, with no tabs or bottom bar to press', async () => {
    mount(OverviewGate);
    const board = await screen.findByRole('status', { name: '每日简报' });
    expect(board.textContent).toContain('已关闭');
    expect(document.querySelector('[inert] [data-page="overview"]')).not.toBeNull();
    expect(slotsEmpty()).toBe(true);
    fireEvent.click(within(board).getByRole('button', { name: /前往开启/ }));
    expect(hashQuery().get('group')).toBe('privacy');
    expect(hashQuery().get('item')).toBe('plugins.daily_brief');
  });

  it('leaves the page alone while it is on', async () => {
    pluginsOn('daily_brief');
    mount(OverviewGate);
    expect(await screen.findByRole('toolbar', { name: '常用操作' })).toBeTruthy();
    expect(document.querySelector('[inert]')).toBeNull();
  });
});

describe('每日简报 blocks', () => {
  it('shows 进行中 as 已关闭 with 个人代理 and 编码会话 both off, leading to 派发任务和定时任务', async () => {
    pluginsOn('daily_brief');
    mount(OverviewPage);
    const strip = await screen.findByRole('status', { name: '进行中' }, { timeout: 3000 });
    expect(strip.textContent).toContain('已关闭');
    fireEvent.click(within(strip).getByRole('button', { name: /前往开启/ }));
    expect(hashQuery().get('group')).toBe('perm');
    expect(hashQuery().get('item')).toBe('plugins.personal_agent');
  });

  it('keeps 屏幕识读 in the action band, disabled with 已关闭', async () => {
    pluginsOn('daily_brief');
    mount(OverviewPage);
    const band = await screen.findByRole('toolbar', { name: '常用操作' });
    const look = within(band).getByRole('button', { name: /^屏幕识读/ });
    expect(look.getAttribute('aria-disabled') === 'true' || look.hasAttribute('disabled')).toBe(true);
    expect(band.textContent + (look.getAttribute('title') ?? '') + (look.getAttribute('aria-description') ?? '')).toContain('已关闭');
  });

  it('says 后台 未接入 with 重启后台 when agentd is lost, in place of the old bar', async () => {
    pluginsOn('daily_brief');
    const restart = vi.spyOn(getBridge().supervisor, 'restart').mockResolvedValue();
    vi.spyOn(getBridge().agentd, 'connection').mockResolvedValue('offline');
    mount(OverviewPage);
    const strip = await screen.findByRole('status', { name: '后台服务' }, { timeout: 3000 });
    expect(strip.textContent).toContain('未接入');
    expect(screen.queryByText(/后台无响应，显示上次读到的数据/)).toBeNull();
    await act(async () => fireEvent.click(within(strip).getByRole('button', { name: /重启后台/ })));
    expect(restart).toHaveBeenCalledWith('agentd');
  });
});

describe('任务 off', () => {
  it('greys the page under a 已关闭 board leading to 派发任务和定时任务, with no 派发任务 to press', async () => {
    mount(TasksGate);
    const board = await screen.findByRole('status', { name: '个人代理与自主能力' });
    expect(board.textContent).toContain('已关闭');
    expect(document.querySelector('[inert] [data-page="tasks"]')).not.toBeNull();
    expect(slotsEmpty()).toBe(true);
    fireEvent.click(within(board).getByRole('button', { name: /前往开启/ }));
    expect(hashQuery().get('group')).toBe('perm');
    expect(hashQuery().get('item')).toBe('plugins.personal_agent');
  });

  it('shows 编码会话 as 已关闭 over the list while 个人代理 is on', async () => {
    pluginsOn('personal_agent');
    mount(TasksPage);
    const strip = await screen.findByRole('status', { name: '编码会话' }, { timeout: 3000 });
    expect(strip.textContent).toContain('已关闭');
    fireEvent.click(within(strip).getByRole('button', { name: /前往开启/ }));
    expect(hashQuery().get('group')).toBe('privacy');
    expect(hashQuery().get('item')).toBe('plugins.coding_sessions');
  });
});

describe('对话 off', () => {
  it('keeps the page\'s character tabs and 停止 out of the top bar', async () => {
    pluginsOn();
    setPlugins({ 'plugins.light_ai': false });
    mount(ChatGate);
    await screen.findByRole('status', { name: 'AI 对话' });
    expect(slotsEmpty()).toBe(true);
  });
});

describe('主页 with the plug-ins at their defaults', () => {
  it('keeps 派发任务 and 屏幕识读 on their keys, off with 已关闭', async () => {
    mount(HomePage);
    const tools = await screen.findByRole('group', { name: '工具' });
    for (const name of ['派发任务', '屏幕识读']) {
      const key = within(tools).getByRole('button', { name });
      expect(key.hasAttribute('disabled')).toBe(true);
      expect(key.getAttribute('title')).toMatch(/^已关闭：/);
    }
  });

  it('shows 待处理 and the disc as 已关闭, the disc leading to the 每日简报 switch', async () => {
    mount(HomePage);
    expect(await screen.findByRole('button', { name: '待处理 已关闭' })).toBeTruthy();
    const strip = await screen.findByRole('status', { name: '每日简报' });
    expect(strip.textContent).toContain('已关闭');
    fireEvent.click(within(strip).getByRole('button', { name: /前往开启/ }));
    expect(hashQuery().get('group')).toBe('privacy');
    expect(hashQuery().get('item')).toBe('plugins.daily_brief');
  });

  it('says 后台 未接入 when the read finds agentd lost', async () => {
    vi.spyOn(getBridge().agentd, 'connection').mockResolvedValue('offline');
    mount(HomePage);
    const status = await screen.findByRole('group', { name: '组件状态' });
    await vi.waitFor(() => expect(status.textContent).toMatch(/^后台未连接/));
  });
});
