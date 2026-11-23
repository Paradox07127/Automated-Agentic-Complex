// Plug-ins decide which ⌘K actions and settings rows a user can use; 开发者模式 decides which developer pages are listed.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { PLUGINS } from '../../src/bridge/plugins.generated';
import { readRunningTasks } from '../../src/pages/character/api';
import { ChatPage } from '../../src/pages/chat/Page';
import { MemoryPage } from '../../src/pages/memory/Page';
import { SettingsPage } from '../../src/pages/settings/Page';
import { GROUP_IDS, REGISTRY } from '../../src/pages/settings/registry';
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

const ids = (dev = false) => visibleRoutes(dev).map((r) => r.id);

describe('plug-in switches', () => {
  it('fill every plug-in from saved settings, a missing or odd value taking the manifest default', () => {
    expect(pluginState({})).toEqual(DEFAULT_PLUGINS);
    expect(DEFAULT_PLUGINS.light_ai).toBe(true);
    expect(Object.entries(DEFAULT_PLUGINS).filter(([, on]) => on).map(([id]) => id)).toEqual(['light_ai']);
    expect(pluginState({ 'plugins.daily_brief': true, 'plugins.screen_reading': 'yes' })).toEqual({ ...DEFAULT_PLUGINS, daily_brief: true });
  });
});

describe('pages a user is offered', () => {
  it('keep 每日简报 and 任务 with their plug-ins off and leave out the developer pages', () => {
    const shown = ids();
    for (const id of ['home', 'chat', 'memory', 'character', 'settings', 'overview', 'tasks']) expect(shown).toContain(id);
    for (const id of ['diag', 'pipeline']) expect(shown).not.toContain(id);
  });

  it('bring the developer pages with 开发者模式', () => {
    for (const id of ['diag', 'pipeline']) expect(ids(true)).toContain(id);
  });

  it('match web.pages of protocol/plugins/plugins.json', () => {
    for (const p of PLUGINS) expect(pageRoutes.filter((r) => r.plugin === p.id).map((r) => r.id).sort(), p.id).toEqual([...p.web.pages].sort());
  });

  it('turn 屏幕识读 and 重新检测内核 off in ⌘K while their plug-ins are off', () => {
    const items = (plugins = DEFAULT_PLUGINS) => paletteItems('', visibleRoutes(false), undefined, {}, {}, plugins);
    const kind = (plugins: typeof DEFAULT_PLUGINS, key: string) => items(plugins).find((i) => i.key === key)?.run.kind;
    for (const key of ['look', 'recheck']) expect(kind(DEFAULT_PLUGINS, key)).toBe('off');
    const all = Object.fromEntries(PLUGINS.map((p) => [p.id, true])) as typeof DEFAULT_PLUGINS;
    expect(kind(all, 'look')).toBe('desktop');
    expect(kind(all, 'recheck')).toBe('recheck');
    expect(items(all).map((i) => i.key)).toContain('page-overview');
  });
});

describe('settings rows of a plug-in', () => {
  it('match web.settings of protocol/plugins/plugins.json', () => {
    for (const p of PLUGINS) {
      for (const s of p.web.settings as readonly string[]) {
        // A whole group is no longer hidden: the plug-in's rows sit in its band inside that group.
        if (!s.includes('.')) {
          expect(GROUP_IDS, s).toContain(s);
          expect(REGISTRY.some((r) => r.group === s && r.plugin === p.id), s).toBe(true);
          continue;
        }
        const entry = REGISTRY.find((r) => r.id === s.slice(s.indexOf('.') + 1));
        if (entry) expect(entry.plugin, s).toBe(p.id);
      }
    }
  });

  it('are not found by the settings search while the plug-in is off; its band switch is', async () => {
    // A result's name is its label, then its 「设置 › 组 › 分区」 path.
    const hits = (label: string) => screen.queryAllByRole('button', { name: new RegExp(`^${label}设置 › `) });
    await mount('');
    fireEvent.change(await screen.findByRole('textbox', { name: '搜索设置' }), { target: { value: '简报' } });
    // The band and the brief's own row share the name; only the band is offered while the plug-in is off.
    expect(hits('每日简报')).toHaveLength(1);
    expect(hits('每周简报')).toEqual([]);
    cleanup();
    // The page takes the switches from config.json, so the plug-in is saved on there too, in a bridge of this test's own.
    pluginsOn('daily_brief');
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    try {
      await window.agenticComplex.settings.save({ 'plugins.daily_brief': true });
      await mount('');
      fireEvent.change(await screen.findByRole('textbox', { name: '搜索设置' }), { target: { value: '简报' } });
      expect(hits('每日简报')).toHaveLength(2);
      expect(hits('每周简报')).toHaveLength(1);
    } finally {
      delete window.agenticComplex;
    }
  });

  it('leave 观察 with the outbound plate, the folded bands and the redaction switch, and hide no group', async () => {
    await mount('&group=privacy');
    expect(await screen.findByRole('switch', { name: '发出前遮蔽敏感内容' })).toBeTruthy();
    for (const gone of ['窗口文字', '读会话里的工具输入输出', '识读时附上截图']) expect(screen.queryByRole('switch', { name: gone })).toBeNull();
    expect(screen.queryByRole('button', { name: '暂停 1 小时' })).toBeNull();
    expect(document.querySelector('[data-row="out"]')).not.toBeNull();
    // Besides the bands' own switches, 键鼠计数 is the only reading left: the coarse beat reads it with screen awareness off.
    const rows = [...document.querySelectorAll('[data-row]:not([data-row^="plugins."])')].filter((r) => r.querySelector('[role="switch"]'));
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual(['keys', 'mask']);
    expect(screen.getByText(/^关着 │ 打开后可以设：窗口文字/)).toBeTruthy();
    const nav = screen.getByRole('tablist', { name: '设置分组' });
    expect(within(nav).getAllByRole('tab').map((t) => t.getAttribute('title'))).toEqual(['说话', '能做', '观察', '内核', '账号', '服务', '按键', '数据', '关于']);
  });

  it('keep developer rows out of 开发者模式 off', async () => {
    await mount('&group=about');
    const fix = await screen.findByRole('region', { name: '排障' });
    for (const gone of ['devparams', 'agentd', 'load']) expect(document.querySelector(`[data-row="${gone}"]`), gone).toBeNull();
    expect(within(fix).getByRole('group', { name: '开发者模式' })).toBeTruthy();
    cleanup();
    setDevMode(true);
    await mount('&group=about');
    await screen.findByRole('region', { name: '排障' });
    for (const back of ['devparams', 'agentd']) expect(document.querySelector(`[data-row="${back}"]`), back).not.toBeNull();
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

  it('read nothing of 个人代理, 屏幕感知 or 日报与简报 on 对话 and 记忆, and 记忆 opens on 档案 without 回顾', async () => {
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
        // 档案 is the only view, so the page draws no tabs.
        await screen.findByRole('button', { name: /^用户档案/ }, { timeout: 3000 });
        expect(screen.queryByRole('tablist', { name: '记忆视图' })).toBeNull();
        expect(screen.queryByRole('tab')).toBeNull();
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

describe('settings › the plug-in bands', () => {
  const band = (id: string) => document.querySelector(`[data-row="plugins.${id}"]`) as HTMLElement;

  it('give the nine plug-ins a band with a switch each in the group they affect, 轻量 AI not among them', async () => {
    const bands: Record<string, string[]> = {
      perm: ['操作电脑', '派发任务和定时任务', '外部智能体接入', '生成新动作'],
      privacy: ['屏幕感知', '屏幕识读', '编码会话', '每日简报'],
      kernel: ['外接 harness'],
    };
    for (const [group, names] of Object.entries(bands)) {
      await mount(`&group=${group}`);
      await screen.findAllByRole('switch');
      if (group === 'kernel') await screen.findByRole('switch', { name: '外接 harness' });
      const shown = [...document.querySelectorAll('[data-row^="plugins."]')];
      expect(shown.map((b) => within(b as HTMLElement).getByRole('switch').getAttribute('aria-label')), group).toEqual(names);
      expect(screen.queryByText(/轻量/)).toBeNull();
      cleanup();
    }
    // The permissions a band needs sit on it as chips; ✕ marks one not granted.
    await mount('&group=privacy');
    await screen.findAllByRole('switch');
    expect(within(band('screen_awareness')).getByText('辅助功能')).toBeTruthy();
    expect(within(band('screen_awareness')).getByText('屏幕录制')).toBeTruthy();
    expect(within(band('daily_brief')).queryByText(/辅助功能|屏幕录制/)).toBeNull();
  });

  it('writes plugins.<id>, waits for a backend restart and shows the plug-in at once', async () => {
    const save = vi.spyOn(getBridge().settings, 'save');
    await mount('&group=privacy');
    await screen.findAllByRole('switch');
    const sw = within(band('daily_brief')).getByRole('switch', { name: '每日简报' });
    expect(getPlugins().daily_brief).toBe(false);
    await act(async () => fireEvent.click(sw));
    expect(save).toHaveBeenCalledWith({ 'plugins.daily_brief': true });
    expect(await screen.findByRole('region', { name: '未应用的改动' })).toBeTruthy();
    expect(screen.getByText(/项重启后台服务后生效/)).toBeTruthy();
    expect(getPlugins().daily_brief).toBe(true);
    await act(async () => fireEvent.click(sw));
    expect(save).toHaveBeenLastCalledWith({ 'plugins.daily_brief': false });
    expect(getPlugins().daily_brief).toBe(false);
  });
});
