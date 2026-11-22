// Plug-ins decide which pages, ⌘K entries and settings rows a user sees; 开发者模式 decides the developer ones.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { PLUGINS } from '../../src/bridge/plugins.generated';
import { readRunningTasks } from '../../src/pages/character/api';
import { ChatPage } from '../../src/pages/chat/Page';
import { MemoryPage } from '../../src/pages/memory/Page';
import { SETTING_GROUPS } from '../../src/pages/settings/groups';
import { SettingsPage } from '../../src/pages/settings/Page';
import { REGISTRY } from '../../src/pages/settings/registry';
import { paletteItems } from '../../src/shell/CmdPalette.data';
import { setDevMode } from '../../src/shell/devMode';
import { DEFAULT_PLUGINS, getPlugins, pluginState } from '../../src/shell/plugins';
import { pageRoutes, visibleRoutes } from '../../src/shell/registry';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  localStorage.clear();
  pluginsReset();
  setDevMode(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
  localStorage.clear();
});

async function mount(search: string) {
  const root = createRootRoute({ component: SettingsPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const ids = (plugins = DEFAULT_PLUGINS, dev = false) => visibleRoutes(plugins, dev).map((r) => r.id);

describe('plug-in switches', () => {
  it('fill every plug-in from saved settings, a missing or odd value taking the manifest default', () => {
    expect(pluginState({})).toEqual(DEFAULT_PLUGINS);
    expect(DEFAULT_PLUGINS.light_ai).toBe(true);
    expect(Object.entries(DEFAULT_PLUGINS).filter(([, on]) => on).map(([id]) => id)).toEqual(['light_ai']);
    expect(pluginState({ 'plugins.daily_brief': true, 'plugins.screen_reading': 'yes' })).toEqual({ ...DEFAULT_PLUGINS, daily_brief: true });
  });
});

describe('pages a user is offered', () => {
  it('leave out 工业简报, 定时任务 and the developer pages with the plug-ins at their defaults', () => {
    const shown = ids();
    for (const id of ['home', 'chat', 'memory', 'character', 'settings']) expect(shown).toContain(id);
    for (const id of ['overview', 'schedules', 'diag', 'trace', 'pipeline', 'tune']) expect(shown).not.toContain(id);
  });

  it('bring 工业简报 back with 日报与简报 on, 定时任务 with 个人代理, the developer pages with 开发者模式', () => {
    expect(ids({ ...DEFAULT_PLUGINS, daily_brief: true })).toContain('overview');
    expect(ids({ ...DEFAULT_PLUGINS, personal_agent: true })).toContain('schedules');
    for (const id of ['diag', 'trace', 'pipeline', 'tune']) expect(ids(DEFAULT_PLUGINS, true)).toContain(id);
  });

  it('match web.pages of protocol/plugins/plugins.json', () => {
    for (const p of PLUGINS) expect(pageRoutes.filter((r) => r.plugin === p.id).map((r) => r.id).sort(), p.id).toEqual([...p.web.pages].sort());
  });

  it('drop 屏幕识读 and 重新检测内核 from ⌘K while their plug-ins are off', () => {
    const keys = (plugins = DEFAULT_PLUGINS) => paletteItems('', visibleRoutes(plugins, false), undefined, {}, {}, plugins).map((i) => i.key);
    expect(keys()).not.toContain('look');
    expect(keys()).not.toContain('recheck');
    expect(keys()).not.toContain('page-overview');
    const all = Object.fromEntries(PLUGINS.map((p) => [p.id, true])) as typeof DEFAULT_PLUGINS;
    expect(keys(all)).toEqual(expect.arrayContaining(['look', 'recheck', 'page-overview']));
  });
});

describe('settings rows of a plug-in', () => {
  it('match web.settings of protocol/plugins/plugins.json', () => {
    for (const p of PLUGINS) {
      const groups = (p.web.settings as readonly string[]).filter((s) => !s.includes('.'));
      expect(SETTING_GROUPS.flatMap((c) => c.items).filter((i) => i.plugin === p.id).map((i) => i.id), p.id).toEqual(groups);
      for (const s of p.web.settings as readonly string[]) {
        if (!s.includes('.')) continue;
        const [group, row] = [s.slice(0, s.indexOf('.')), s.slice(s.indexOf('.') + 1)];
        const entry = REGISTRY.find((r) => r.id === row);
        if (entry) expect([entry.group, entry.plugin], s).toEqual([group, p.id]);
      }
    }
  });

  it('are not found by the settings search while the plug-in is off', async () => {
    await mount('');
    fireEvent.change(await screen.findByRole('textbox', { name: '搜索设置' }), { target: { value: '简报' } });
    expect(screen.queryByRole('button', { name: /每日简报/ })).toBeNull();
    cleanup();
    pluginsOn('daily_brief');
    await mount('');
    fireEvent.change(await screen.findByRole('textbox', { name: '搜索设置' }), { target: { value: '简报' } });
    expect(screen.getByRole('button', { name: /每日简报/ })).toBeTruthy();
  });

  it('leave 隐私 with the outbound plate and the redaction switch, and hide the 角色内核 group', async () => {
    await mount('&group=privacy');
    expect(await screen.findByRole('switch', { name: '遮蔽敏感内容' })).toBeTruthy();
    for (const gone of ['窗口文字', '读取编码会话', '附上截图']) expect(screen.queryByRole('switch', { name: gone })).toBeNull();
    expect(screen.queryByRole('button', { name: '暂停 1 小时' })).toBeNull();
    // 键鼠计数 feeds the coarse beat, which runs with screen awareness off; it is the region's only row then.
    const scope = screen.getByRole('region', { name: '读取范围' });
    expect(within(scope).getAllByRole('switch')).toHaveLength(1);
    expect(within(scope).getByRole('switch', { name: '键鼠计数' })).toBeTruthy();
    const nav = screen.getByRole('tablist', { name: '设置分组' });
    expect(within(nav).queryByRole('tab', { name: /角色内核/ })).toBeNull();
    expect(within(nav).getAllByRole('tab')[0]?.getAttribute('title')).toBe('插件');
  });

  it('keep developer rows out of 开发者模式 off', async () => {
    await mount('&group=adv');
    expect(await screen.findByRole('region', { name: '排障' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '开发者参数' })).toBeNull();
    expect(screen.queryByRole('region', { name: '后台服务' })).toBeNull();
    cleanup();
    await mount('&group=about');
    expect(await screen.findByRole('region', { name: '关于' })).toBeTruthy();
    expect(document.querySelector('[data-row="load"]')).toBeNull();
    expect(document.querySelector('[data-row="dev"]')).not.toBeNull();
  });
});

describe('core pages with the plug-ins at their defaults', () => {
  function spyPaths() {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    const paths: string[] = [];
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      paths.push(path.split('?')[0]!);
      return (await real(method, path, body)) as never;
    });
    return paths;
  }
  const OFF_READS = /^\/(agent\/(tasks|runs|interactions)|tasks|schedules|observation|memory\/tasks)(\/|$)/;

  it('read nothing of 个人代理, 屏幕感知 or 日报与简报 on 对话 and 记忆, and 记忆 opens on 用户档案 without 活动回顾', async () => {
    const paths = spyPaths();
    for (const Page of [ChatPage, MemoryPage]) {
      const root = createRootRoute({ component: Page });
      const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      if (Page === MemoryPage) {
        expect((await screen.findByRole('tab', { name: /用户档案/ }, { timeout: 3000 })).getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByRole('tab', { name: /活动回顾/ })).toBeNull();
        expect(screen.queryByRole('tab', { name: /项目/ })).toBeNull();
      } else await screen.findByRole('region', { name: '消息' }, { timeout: 3000 });
      // The reads a page starts on mount have gone out.
      await act(async () => new Promise((r) => setTimeout(r, 300)));
      cleanup();
    }
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => OFF_READS.test(p))).toEqual([]);
  });

  it('switch characters without asking 个人代理 for running tasks', async () => {
    const paths = spyPaths();
    expect(await readRunningTasks()).toEqual([]);
    expect(paths).toEqual([]);
  });
});

describe('settings › 插件', () => {
  it('lists the nine plug-ins with a switch each, 轻量 AI not among them', async () => {
    await mount('&group=plugins');
    const sec = await screen.findByRole('region', { name: '插件' });
    const names = within(sec).getAllByRole('switch').map((s) => s.getAttribute('aria-label'));
    expect(names).toEqual(['屏幕感知', '屏幕识读', '日报与简报', '编码会话', '个人代理', 'Agent 内核桥接', '电脑操作', '外部接入', '动作生成']);
    expect(within(sec).queryByText(/轻量/)).toBeNull();
    // Permission tags beside the plug-ins that need them.
    expect(within(document.querySelector('[data-row="plugins.screen_awareness"]') as HTMLElement).getByText('辅助功能 │ 已允许')).toBeTruthy();
    expect(within(document.querySelector('[data-row="plugins.daily_brief"]') as HTMLElement).queryByText(/│/)).toBeNull();
  });

  it('writes plugins.<id>, waits for a backend restart and shows the plug-in at once', async () => {
    const save = vi.spyOn(getBridge().settings, 'save');
    await mount('&group=plugins');
    const sw = await screen.findByRole('switch', { name: '日报与简报' });
    expect(getPlugins().daily_brief).toBe(false);
    await act(async () => fireEvent.click(sw));
    expect(save).toHaveBeenCalledWith({ 'plugins.daily_brief': true });
    expect(await screen.findByRole('region', { name: '未应用的改动' })).toBeTruthy();
    expect(screen.getByText(/项重启后台服务后生效/)).toBeTruthy();
    expect(getPlugins().daily_brief).toBe(true);
    expect(ids(getPlugins())).toContain('overview');
    await act(async () => fireEvent.click(sw));
    expect(save).toHaveBeenLastCalledWith({ 'plugins.daily_brief': false });
    expect(getPlugins().daily_brief).toBe(false);
  });
});
