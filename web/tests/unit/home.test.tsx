// 主页：手表菜单的按键取自路由表，圆盘和底部槽取自工业简报的读数，每个可点元素跳到对应页面或位置。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { demos } from '../../src/pages/home/demos';
import { BAR_SLOTS, CLOCK, leftTiles, rightTiles, sideIcons, STAGE, TOP_ICONS } from '../../src/pages/home/geometry';
import { HomePage } from '../../src/pages/home/Page';
import { setDevMode } from '../../src/shell/devMode';
import { OPEN_PALETTE } from '../../src/shell/Layout';
import { pageRoutes } from '../../src/shell/registry';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = '';
});

function mount(search = '') {
  const root = createRootRoute({ component: HomePage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const title = (id: string) => pageRoutes.find((r) => r.id === id)!.title;
/** The overview's reads the home page made for 待处理, 在做 and the today card. */
const TODAY_READS = ['/agent/snapshot', '/sessions', '/agent/runs', '/trace/turns', '/day/segments', '/episodes', '/trace/decisions'];
const names = (group: HTMLElement) => within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

describe('home route', () => {
  it('is the first page, so / lands on it, with ⌘0', () => {
    expect(pageRoutes[0]?.id).toBe('home');
    expect(pageRoutes[0]?.hotkey).toBe('⌘0');
    expect(pageRoutes.find((r) => r.id === 'overview')?.hotkey).toBe('⌘1');
  });

  it('has the normal, loading, empty, error and still demos', () => {
    const params = demos.map((d) => d.params);
    for (const p of [{}, { state: 'loading' }, { state: 'empty' }, { state: 'error' }, { still: '1' }]) expect(params).toContainEqual(p);
  });
});

describe('home tiles', () => {
  it('names the keys by the registry and lists devOnly pages only in 开发者模式', async () => {
    setDevMode(true);
    mount();
    expect(names(await screen.findByRole('group', { name: '主要页面' }))).toEqual(['character', 'chat', 'memory', 'schedules'].map(title));
    expect(names(screen.getByRole('group', { name: '工具' }))).toEqual([...['settings', 'trace'].map(title), '派发任务', '搜索']);
    expect(names(screen.getByRole('group', { name: '快捷动作' }))).toEqual(['屏幕识读', '快速输入', '停止说话', ...['diag', 'pipeline', 'tune'].map(title)]);
    // Key hints stay in the DOM; html[data-keys] only shows them.
    expect(within(screen.getByRole('group', { name: '主要页面' })).getByRole('button', { name: '对话' }).textContent).toContain('⌘2');
    cleanup();
    setDevMode(false);
    mount();
    expect(names(await screen.findByRole('group', { name: '工具' }))).toEqual([title('settings'), '派发任务', '搜索']);
    expect(names(screen.getByRole('group', { name: '快捷动作' }))).toEqual(['屏幕识读', '快速输入', '停止说话']);
  });

  it('writes each 快捷动作 name under its icon', async () => {
    mount();
    const side = await screen.findByRole('group', { name: '快捷动作' });
    for (const b of within(side).getAllByRole('button')) expect(b.textContent).toBe(b.getAttribute('aria-label'));
  });

  it('jumps to each page, dispatches a role task and opens the palette', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '记忆' }));
    expect(window.location.hash).toMatch(/^#\/memory\?/);
    fireEvent.click(screen.getByRole('button', { name: '定时任务' }));
    expect(window.location.hash).toMatch(/^#\/schedules\?/);
    fireEvent.click(screen.getByRole('button', { name: /^角色：/ }));
    expect(window.location.hash).toMatch(/^#\/character\?/);
    fireEvent.click(screen.getByRole('button', { name: '打开对话' }));
    expect(window.location.hash).toMatch(/^#\/chat\?/);
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
    expect(window.location.hash).toMatch(/^#\/trace\?/);
    fireEvent.click(screen.getByRole('button', { name: title('diag') }));
    expect(window.location.hash).toMatch(/^#\/diag\?/);
    fireEvent.click(screen.getByRole('button', { name: '派发任务' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '新建' })).getByRole('button', { name: /取消/ }));
    const open = vi.fn();
    window.addEventListener(OPEN_PALETTE, open);
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    window.removeEventListener(OPEN_PALETTE, open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps every clickable element a named button', async () => {
    mount();
    await screen.findByRole('group', { name: '工具' });
    for (const b of document.querySelectorAll('[data-page="home"] button')) expect(b.getAttribute('aria-label') || b.textContent?.trim(), b.outerHTML.slice(0, 80)).toBeTruthy();
  });
});

describe('home disc', () => {
  it('counts 待处理 and 在做, lands them on 工业简报 and puts the first waiting item on the disc', async () => {
    mount();
    const pending = await screen.findByRole('button', { name: /^待处理 \d+$/ }, { timeout: 3000 });
    const n = Number(pending.getAttribute('aria-label')!.split(' ')[1]);
    expect(n).toBeGreaterThan(0);
    fireEvent.click(pending);
    expect(window.location.hash).toMatch(/^#\/overview\?.*focus=pending/);
    const brief = screen.getByRole('button', { name: /^工业简报：待办 \d+ │ 在做 \d+$/ });
    expect(brief.getAttribute('aria-label')).toContain(`待办 ${n} `);
    window.location.hash = '';
    fireEvent.click(brief);
    expect(window.location.hash).toMatch(/^#\/overview\?/);
    const first = within(screen.getByRole('region', { name: title('character') })).getByRole('group', { name: /^(审批|提问|复核)：/ });
    fireEvent.click(within(first).getAllByRole('button')[0]!);
    expect(window.location.hash).toMatch(/^#\/overview\?sel=([^&]+)&focus=item-\1/);
  });

  it('shows dashes while reading and zeros on an empty day', async () => {
    mount('&state=loading');
    expect(await screen.findAllByRole('button', { name: /^待处理 —$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '工业简报：待办 — │ 在做 —' })).toBeTruthy();
    expect(screen.getByText('读取中')).toBeTruthy();
    cleanup();
    mount('&state=empty');
    expect(await screen.findAllByRole('button', { name: '待处理 0' }, { timeout: 3000 })).toHaveLength(1);
    expect(await screen.findByRole('button', { name: '工业简报：待办 0 │ 在做 0' })).toBeTruthy();
    expect(screen.queryAllByRole('group', { name: /^(审批|提问|复核)：/ })).toEqual([]);
  });
});

describe('home geometry', () => {
  it('keeps the keys, the top icons, the named side icons, the bar slots and the clock on the stage', () => {
    for (const b of [...leftTiles(4), ...rightTiles(8), ...TOP_ICONS, ...sideIcons(6), ...BAR_SLOTS, CLOCK]) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(STAGE.w);
      expect(b.top + b.height).toBeLessThanOrEqual(STAGE.h);
    }
  });
});

describe('home fit', () => {
  function sized(width: number, height: number) {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
    mount();
  }
  const scale = () => Number((document.querySelector('[data-page="home"] > div:last-child') as HTMLElement).style.getPropertyValue('--k'));

  afterEach(() => vi.unstubAllGlobals());

  it('stops shrinking where the stage 12px text would render under 11px', async () => {
    sized(876, 600);
    await screen.findByRole('group', { name: '主要页面' });
    expect(scale() * 12).toBeGreaterThanOrEqual(11);
    expect(screen.getByRole('group', { name: '快捷动作' })).toBeTruthy();
  });

  it('folds the 快捷动作 column instead of shrinking further when the face does not fit', async () => {
    sized(720, 600);
    await screen.findByRole('group', { name: '主要页面' });
    expect(scale() * 12).toBeGreaterThanOrEqual(11);
    expect(screen.queryByRole('group', { name: '快捷动作' })).toBeNull();
    expect(screen.getByRole('group', { name: '工具' })).toBeTruthy();
  });
});

describe('home with the plug-ins at their defaults', () => {
  beforeEach(() => {
    pluginsReset();
    setDevMode(false);
  });

  it('keeps only 角色, 对话, 记忆 and 设置 among the pages, and no 待处理, 提醒, 派发任务, 屏幕识读 or today card', async () => {
    mount();
    expect(names(await screen.findByRole('group', { name: '主要页面' }))).toEqual(['character', 'chat', 'memory'].map(title));
    expect(names(screen.getByRole('group', { name: '工具' }))).toEqual([title('settings'), '搜索']);
    expect(names(screen.getByRole('group', { name: '快捷动作' }))).toEqual(['快速输入', '停止说话']);
    for (const gone of [/^待处理/, /^提醒$/, /^派发任务$/, /^屏幕识读$/, /^工业简报：/]) expect(screen.queryByRole('button', { name: gone })).toBeNull();
    expect(screen.getByRole('button', { name: '打开对话' })).toBeTruthy();
    // The bar's glow band lies under the one slot left, not under the empty card slot.
    const band = document.querySelector<HTMLElement>('[data-g="hudBar"] > span[aria-hidden="true"]')!;
    expect([band.style.left, band.style.width]).toEqual([`${BAR_SLOTS[1].left}px`, `${BAR_SLOTS[1].width}px`]);
  });

  it('sends none of the today reads with 日报与简报 off, and the clock reads /health, not them, for 已连接', async () => {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    const paths: string[] = [];
    // As agentd: a plug-in's routes answer 409 plugin_off while it is off; /agent/snapshot stands for the overview's reads.
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      paths.push(path.split('?')[0]!);
      return (TODAY_READS.includes(path.split('?')[0]!) ? { status: 409, body: { error: 'plugin_off' } } : await real(method, path, body)) as never;
    });
    mount();
    const clock = await screen.findByRole('group', { name: '时钟' });
    expect(await within(clock).findByText('已连接')).toBeTruthy();
    expect(paths).toContain('/health');
    expect(paths.filter((p) => TODAY_READS.includes(p))).toEqual([]);
    expect(within(clock).queryByText('读取失败')).toBeNull();
  });

  it('offers 派发任务 with 个人代理 on and 日报与简报 off, and opens the dispatch dialog in place', async () => {
    pluginsOn('personal_agent');
    mount();
    expect(names(await screen.findByRole('group', { name: '工具' }))).toEqual([title('settings'), '派发任务', '搜索']);
    fireEvent.click(screen.getByRole('button', { name: '派发任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建' });
    expect(within(dialog).getByRole('button', { name: /交派/ })).toBeTruthy();
    expect(window.location.hash).not.toMatch(/overview/);
  });

  it('adds 待处理, 提醒 and the today card once 日报与简报 is on, and 派发任务 once 个人代理 is on too', async () => {
    pluginsOn('daily_brief');
    mount();
    expect(await screen.findByRole('button', { name: /^待处理 / })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提醒' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^工业简报：/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '派发任务' })).toBeNull();
    cleanup();
    pluginsOn('daily_brief', 'personal_agent', 'screen_reading');
    mount();
    expect(names(await screen.findByRole('group', { name: '工具' }))).toEqual([title('settings'), '派发任务', '搜索']);
    expect(names(screen.getByRole('group', { name: '主要页面' }))).toEqual(['character', 'chat', 'memory', 'schedules'].map(title));
    expect(names(screen.getByRole('group', { name: '快捷动作' }))).toEqual(['屏幕识读', '快速输入', '停止说话']);
  });
});
