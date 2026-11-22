import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge, type AvatarState } from '../../src/bridge';
import { CmdPalette } from '../../src/shell/CmdPalette';
import { paletteItems } from '../../src/shell/CmdPalette.data';
import { CommandBar } from '../../src/shell/CommandBar';
import { HeaderSlotContext, PageHeaderSlot } from '../../src/shell/headerSlot';
import { NotFound } from '../../src/shell/Placeholder';
import { pageRoutes } from '../../src/shell/registry';
import { createAppRouter } from '../../src/shell/router';
import { setDevMode } from '../../src/shell/devMode';
import { Tabs } from '../../src/ui';
import { stubMatchMedia } from './mediaStub';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** The shell's slots around the command bar, as Layout wires them; `page` fills them through PageHeaderSlot. */
function Shell({ activeId, page }: { activeId: string; page?: ReactNode }) {
  const [sub, setSub] = useState<string | null>(null);
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null);
  const [right, setRight] = useState<HTMLDivElement | null>(null);
  const [action, setAction] = useState<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState<HTMLDivElement | null>(null);
  const title = pageRoutes.find((r) => r.id === activeId)?.title ?? '';
  return (
    <HeaderSlotContext.Provider value={{ setSub, tabs, right, action, bottom }}>
      <CommandBar routes={pageRoutes} activeId={activeId} title={title} sub={sub} tabsRef={setTabs} rightRef={setRight} actionRef={setAction} />
      <div ref={setBottom} data-shell="bottom-bar" data-slot="bottom" data-theme="dark" />
      {page}
    </HeaderSlotContext.Provider>
  );
}

async function mountCommandBar(activeId: string, page?: () => ReactNode) {
  const root = createRootRoute({ component: () => <Shell activeId={activeId} page={page?.()} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const ui = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...ui, nav: await screen.findByRole('navigation', { name: '主导航' }) };
}

/** A page with three icon tabs in the bar; the bar's Q / E click them. */
function TabsPage() {
  const [tab, setTab] = useState('a');
  return (
    <>
      <PageHeaderSlot
        tabs={
          <Tabs
            label="测试页签"
            keys={false}
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'a', label: '甲', icon: 'play' },
              { id: 'b', label: '乙', icon: 'look' },
              { id: 'c', label: '丙', icon: 'tune' },
            ]}
          />
        }
      />
      <input aria-label="测试输入" />
    </>
  );
}

describe('CommandBar', () => {
  beforeEach(() => stubMatchMedia());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('lists every page but 主页 in the page menu, user pages first and developer pages only in 开发者模式', async () => {
    setDevMode(false);
    const { nav } = await mountCommandBar('overview');
    expect(within(nav).queryAllByRole('link')).toEqual([]);
    const trigger = within(nav).getByRole('button', { name: '每日简报' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    const items = within(screen.getByRole('menu', { name: '每日简报' })).getAllByRole('menuitem');
    const user = pageRoutes.filter((r) => r.id !== 'home' && r.id !== 'onboarding' && (r.nav !== false || r.id === 'tasks') && r.group !== 'dev' && !r.devOnly);
    expect(items.map((i) => i.querySelector('span')?.textContent)).toEqual(user.map((r) => r.title));
    expect(items.map((i) => i.textContent)).not.toContain('首次设置');
    expect(items.find((i) => i.textContent?.startsWith('设置'))?.querySelector('kbd')?.textContent).toBe('⌘,');
    fireEvent.click(items.find((i) => i.textContent?.startsWith('对话'))!);
    expect(window.location.hash).toMatch(/^#\/chat\?/);
    cleanup();

    setDevMode(true);
    const dev = await mountCommandBar('diag');
    fireEvent.click(within(dev.nav).getByRole('button', { name: '诊断' }));
    const all = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.querySelector('span')?.textContent);
    expect(all.slice(0, user.length)).toEqual(user.map((r) => r.title));
    expect(all.slice(user.length)).toEqual(expect.arrayContaining(['管线', '调参']));
    expect(screen.getByRole('menu').querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('names the page menu 页面名 / 选中页签名 and has the tabs, status and action slots that pages fill', async () => {
    const { nav, container } = await mountCommandBar('settings', () => (
      <>
        <PageHeaderSlot
          sub="隐私"
          right={<span>已连接</span>}
          action={<button type="button">派发任务</button>}
          bottom={<span>3 段对话，6 个编码会话</span>}
        />
        <TabsPage />
      </>
    ));
    expect(within(nav.querySelector('[data-slot="status"]') as HTMLElement).getByText('已连接')).toBeTruthy();
    expect(within(nav.querySelector('[data-slot="action"]') as HTMLElement).getByRole('button', { name: '派发任务' })).toBeTruthy();
    expect(within(nav.querySelector('[data-slot="tabs"]') as HTMLElement).getByRole('tablist', { name: '测试页签' })).toBeTruthy();
    const bottomBar = container.querySelector('[data-shell="bottom-bar"]') as HTMLElement;
    expect(within(bottomBar).getByText('3 段对话，6 个编码会话')).toBeTruthy();
    // The selected icon tab's name beats the page's sub.
    expect(await within(nav).findByRole('button', { name: '设置 / 甲' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '乙' }));
    expect(await within(nav).findByRole('button', { name: '设置 / 乙' })).toBeTruthy();
    expect([...nav.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['esc', 'Q', 'E']);
  });

  it('starts with 回主页 (⟨ 主页, esc cap always shown), goes home from it, and has no ✕', async () => {
    const { nav } = await mountCommandBar('settings', () => <TabsPage />);
    const first = nav.querySelector<HTMLElement>('button, a, [tabindex]:not([tabindex="-1"])');
    const home = within(nav).getByRole('button', { name: '回主页' });
    expect(first).toBe(home);
    expect(home.textContent).toBe('主页esc');
    expect(home.querySelector('[data-icon="chevl"]')).toBeTruthy();
    expect(home.querySelector('kbd')?.closest('[aria-hidden="true"]')).toBeNull();
    expect(within(nav).getAllByRole('button', { name: '回主页' })).toHaveLength(1);
    expect(nav.querySelector('[data-icon="close"]')).toBeNull();
    fireEvent.click(home);
    expect(window.location.hash).toMatch(/^#\/home\?/);
  });

  it('shows the sub when no tab is selected', async () => {
    const { nav } = await mountCommandBar('settings', () => <PageHeaderSlot sub="隐私" />);
    expect(await within(nav).findByRole('button', { name: '设置 / 隐私' })).toBeTruthy();
  });

  it('shows 后台 / 内核 / 角色 as one status chip, without 语音; it lists the three and opens 诊断 only in 开发者模式', async () => {
    const base: AvatarState = { running: true, visible: true, scale: 1, clickThroughAll: false, speaking: false, characterId: 'si', appearanceId: 'default' };
    vi.spyOn(getBridge().avatar, 'state').mockResolvedValue(base);
    setDevMode(false);
    const { nav } = await mountCommandBar('overview');
    const chip = await within(nav).findByRole('button', { name: '已连接' });
    expect(chip.getAttribute('aria-haspopup')).toBe('menu');
    expect(nav.textContent).not.toContain('语音');
    fireEvent.click(chip);
    const items = within(screen.getByRole('menu', { name: '已连接' })).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['后台：已连接', '内核：已就绪', '角色：在桌面']);
    fireEvent.click(items[0]!);
    expect(window.location.hash).toBe('');
    cleanup();

    setDevMode(true);
    const dev = await mountCommandBar('overview');
    fireEvent.click(await within(dev.nav).findByRole('button', { name: '已连接' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '查看诊断' }));
    expect(window.location.hash).toMatch(/^#\/diag\?/);
  });

  it('names the worst light on the chip when one is not fine', async () => {
    vi.spyOn(getBridge().agentd, 'connection').mockResolvedValue('offline');
    const { nav } = await mountCommandBar('overview');
    expect(await within(nav).findByRole('button', { name: '后台已断开' })).toBeTruthy();
  });

  it('updates the 角色 light when avatar state is pushed', async () => {
    const base: AvatarState = { running: true, visible: true, scale: 1, clickThroughAll: false, speaking: false, characterId: 'si', appearanceId: 'default' };
    let push: (s: AvatarState) => void = () => {};
    vi.spyOn(getBridge().avatar, 'state').mockResolvedValue(base);
    vi.spyOn(getBridge().avatar, 'onState').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    const { nav } = await mountCommandBar('overview');
    fireEvent.click(await within(nav).findByRole('button', { name: '已连接' }));
    expect(await within(screen.getByRole('menu')).findByRole('menuitem', { name: '角色：在桌面' })).toBeTruthy();
    act(() => push({ ...base, speaking: true }));
    expect(await within(screen.getByRole('menu')).findByRole('menuitem', { name: '角色：说话中' })).toBeTruthy();
  });

  it("steps through the page's own tabs on Q and E and wraps around, ignores inputs, and goes home on Esc and 回主页", async () => {
    await mountCommandBar('settings', () => <TabsPage />);
    const selected = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.getAttribute('title');
    expect(selected()).toBe('甲');
    for (const expected of ['乙', '丙', '甲']) {
      fireEvent.keyDown(window, { key: 'e' });
      expect(selected()).toBe(expected);
    }
    for (const expected of ['丙', '乙', '甲']) {
      fireEvent.keyDown(window, { key: 'q' });
      expect(selected()).toBe(expected);
    }
    const input = screen.getByRole('textbox', { name: '测试输入' });
    input.focus();
    fireEvent.keyDown(input, { key: 'e' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(selected()).toBe('甲');
    expect(window.location.hash).toBe('');
    input.blur();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(window.location.hash).toMatch(/^#\/home\?/);
    window.location.hash = '';
    fireEvent.click(screen.getByRole('button', { name: '回主页' }));
    expect(window.location.hash).toMatch(/^#\/home\?/);
  });
});

describe('NotFound', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('offers 回到主页', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('没有这个页面');
    fireEvent.click(screen.getByRole('button', { name: /回到主页/ }));
    expect(window.location.hash).toMatch(/^#\/home\?/);
  });
});

describe('page switch', () => {
  afterEach(() => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    window.location.hash = '';
  });

  it('goes from a page back to 主页 through 回主页, and 主页 has no 回主页', async () => {
    stubMatchMedia();
    window.location.hash = '#/tasks?still=1';
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={createAppRouter()} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '回主页' }));
    await vi.waitFor(() => expect(document.querySelector('main[data-route-id="home"]')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '回主页' })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('cuts straight to the next page: the app router starts no view transition', async () => {
    const start = vi.fn((update: () => unknown) => {
      const done = Promise.resolve(update()).then(() => undefined);
      return { updateCallbackDone: done, ready: done, finished: done, skipTransition: () => {} };
    });
    Object.assign(document, { startViewTransition: start });
    const router = createAppRouter();
    await router.navigate({ to: '/chat' });
    await router.navigate({ to: '/overview' });
    await router.navigate({ to: '/settings' });
    expect(router.state.location.pathname).toBe('/settings');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('CmdPalette', () => {
  it('gives page items their shortcut and no English hint', () => {
    const pages = paletteItems('', pageRoutes, undefined).filter((i) => i.group === '跳页');
    expect(pages.find((i) => i.label === '每日简报')?.shortcut).toBe('⌘1');
    expect(pages.find((i) => i.label === '设置')?.shortcut).toBe('⌘,');
    expect(pages.map((i) => i.label)).not.toContain('首次设置');
    for (const p of pages) expect(pageRoutes.map((r) => r.en)).not.toContain(p.hint);
  });

  it('heads each group with its count and shows shortcuts as key caps', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CmdPalette routes={pageRoutes} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const list = screen.getByRole('listbox');
    const heads = [...list.querySelectorAll('[data-group]')].map((h) => h.textContent);
    expect(heads[0]).toBe(`跳页[${pageRoutes.filter((r) => r.nav !== false).length}]`);
    expect(heads.at(-1)).toMatch(/^动作\[\d+\]$/);
    const overview = within(list).getByRole('option', { name: /每日简报/ });
    expect(overview.querySelector('kbd')?.textContent).toBe('⌘1');
    expect(list.textContent).not.toContain('Today');
  });
});
