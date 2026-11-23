// 主页：手表菜单的按键取自路由表，圆盘取自每日简报的待处理和今日任务，每个可点元素跳到对应页面或位置。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { demos } from '../../src/pages/home/demos';
import { BANNER, BAR_SLOTS, CARD, COUNTERS, leftTiles, rightTiles, STAGE, TOP_ICONS, type Box } from '../../src/pages/home/geometry';
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
/** The left keys. */
const LEFT = (...ids: string[]) => ids.map(title);
const ACTIONS = ['派发任务', '搜索', '屏幕识读', '快速输入', '停止说话'];

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
    expect(names(await screen.findByRole('group', { name: '主要页面' }))).toEqual(LEFT('character', 'chat', 'memory', 'tasks'));
    expect(names(screen.getByRole('group', { name: '工具' }))).toEqual([title('trace'), ...ACTIONS, ...['diag', 'pipeline', 'tune'].map(title)]);
    // Key hints stay in the DOM; html[data-keys] only shows them.
    expect(within(screen.getByRole('group', { name: '主要页面' })).getByRole('button', { name: '对话' }).textContent).toContain('⌘2');
    cleanup();
    setDevMode(false);
    mount();
    expect(names(await screen.findByRole('group', { name: '工具' }))).toEqual(ACTIONS);
  });

  it('spells the key hints Ctrl on the Windows shell', async () => {
    window.agenticComplex = { ...createFakeBridge({ surface: 'main', still: true }), platform: 'windows' };
    try {
      mount();
      const main = await screen.findByRole('group', { name: '主要页面' });
      expect(within(main).getByRole('button', { name: '对话' }).textContent).toContain('Ctrl+2');
      expect(within(screen.getByRole('group', { name: '工具' })).getByRole('button', { name: '搜索' }).textContent).toContain('Ctrl+K');
      expect(document.body.textContent).not.toMatch(/[⌘⌃⌥⇧]/);
    } finally {
      delete window.agenticComplex;
    }
  });

  it('writes each key name under its icon', async () => {
    mount();
    const keys = [...within(await screen.findByRole('group', { name: '工具' })).getAllByRole('button'), ...within(screen.getByRole('group', { name: '主要页面' })).getAllByRole('button')];
    for (const b of keys) expect(b.textContent).toContain(b.getAttribute('aria-label'));
  });

  it('jumps to each page, dispatches a role task and opens the palette', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '记忆' }));
    expect(window.location.hash).toMatch(/^#\/memory\?/);
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(window.location.hash).toMatch(/^#\/tasks\?/);
    fireEvent.click(screen.getByRole('button', { name: title('settings') }));
    expect(window.location.hash).toMatch(/^#\/settings\?/);
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
  it('counts 待处理 and 在做, lands them on 每日简报 and puts the first waiting item on the disc', async () => {
    mount();
    const pending = await screen.findByRole('button', { name: /^待处理 \d+$/ }, { timeout: 3000 });
    const n = Number(pending.getAttribute('aria-label')!.split(' ')[1]);
    expect(n).toBeGreaterThan(0);
    fireEvent.click(pending);
    expect(window.location.hash).toMatch(/^#\/overview\?.*focus=pending/);
    for (const name of [title('overview'), /^今日任务 完成 \d+ \/ \d+$/]) {
      window.location.hash = '';
      fireEvent.click(screen.getByRole('button', { name }));
      expect(window.location.hash).toMatch(/^#\/overview\?/);
    }
    const disc = screen.getByRole('region', { name: '待批准' });
    expect(within(disc).getByRole('button', { name: `另有 ${n - 1} 件待处理` })).toBeTruthy();
    const first = within(disc).getByRole('group', { name: /^(审批|提问|复核)：/ });
    fireEvent.click(within(first).getAllByRole('button')[0]!);
    expect(window.location.hash).toMatch(/^#\/overview\?sel=([^&]+)&focus=item-\1/);
  });

  it('puts the next reminder on the banner and lands it on 每日简报 at the reminders', async () => {
    mount();
    const banner = await screen.findByRole('button', { name: /^提醒：.+ \S+$/ }, { timeout: 3000 });
    fireEvent.click(banner);
    expect(window.location.hash).toMatch(/^#\/overview\?.*focus=reminders/);
  });

  it('puts only a delivery made today on the banner', async () => {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    let shift = 0;
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      // A copy: the fake bridge hands out its shared fixtures.
      const r = structuredClone(await real(method, path, body)) as { status: number; body: { deliveries?: { deliveries: Array<{ produced_at: number }> } } };
      if (path.startsWith('/agent/snapshot')) for (const d of r.body.deliveries?.deliveries ?? []) d.produced_at -= shift;
      return r as never;
    });
    mount();
    const named = () => screen.queryAllByRole('button').some((b) => /^交付：/.test(b.getAttribute('aria-label') ?? ''));
    await screen.findByRole('button', { name: /^提醒：/ }, { timeout: 3000 });
    // Step the banner to its second item when it has one.
    for (const b of screen.queryAllByRole('button', { name: '下一条' })) fireEvent.click(b);
    expect(named()).toBe(true);
    cleanup();
    shift = 86_400;
    mount();
    await screen.findByRole('button', { name: /^提醒：/ }, { timeout: 3000 });
    for (const b of screen.queryAllByRole('button', { name: '下一条' })) fireEvent.click(b);
    expect(named()).toBe(false);
  });

  it('turns the disc to 在做 and lists what runs, with no 今日 page: the counts are on 每日简报', async () => {
    mount();
    const tabs = await screen.findByRole('tablist', { name: '圆盘' }, { timeout: 3000 });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+/g, ''))).toEqual(['待批准', '在做']);
    fireEvent.click(within(tabs).getByRole('tab', { name: /^在做/ }));
    const running = screen.getByRole('tabpanel', { name: '在做' });
    expect(within(running).getAllByRole('button', { name: /^(对话|任务|编码)：/ }).length).toBeGreaterThan(0);
  });

  it('turns the disc page by a sideways drag or trackpad swipe and ignores a vertical drag', async () => {
    mount();
    await screen.findByRole('tablist', { name: '圆盘' }, { timeout: 3000 });
    const page = () => screen.getByRole('tabpanel').getAttribute('aria-label');
    expect(page()).toBe('待批准');
    fireEvent.pointerDown(screen.getByRole('tabpanel'), { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole('tabpanel'), { clientX: 200, clientY: 20 });
    expect(page()).toBe('待批准');
    fireEvent.pointerDown(screen.getByRole('tabpanel'), { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole('tabpanel'), { clientX: 120, clientY: 110 });
    expect(page()).toBe('在做');
    fireEvent.pointerDown(screen.getByRole('tabpanel'), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(screen.getByRole('tabpanel'), { clientX: 200, clientY: 100 });
    expect(page()).toBe('待批准');
    fireEvent.wheel(screen.getByRole('tabpanel'), { deltaX: 60, deltaY: 2 });
    expect(page()).toBe('在做');
  });

  it('keeps a swipe from pressing the button it starts on, turns on a release outside the panel and lets slow wheel jitter fade', async () => {
    mount();
    await screen.findByRole('tablist', { name: '圆盘' }, { timeout: 3000 });
    const page = () => screen.getByRole('tabpanel').getAttribute('aria-label');
    const more = await screen.findByRole('button', { name: /^另有 \d+ 件待处理$/ });
    window.location.hash = '';
    // Right from the first page: no page before it, and the click that ends the drag must not land.
    fireEvent.pointerDown(more, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(more, { clientX: 200, clientY: 100 });
    fireEvent.click(more);
    expect(window.location.hash).toBe('');
    expect(page()).toBe('待批准');
    // A plain click still works.
    fireEvent.pointerDown(more, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(more, { clientX: 101, clientY: 100 });
    fireEvent.click(more);
    expect(window.location.hash).toMatch(/^#\/overview\?/);
    fireEvent.pointerDown(screen.getByRole('tabpanel'), { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(document.body, { clientX: 100, clientY: 100 });
    expect(page()).toBe('在做');
    // Two small sideways nudges far apart in time are not one swipe.
    // jsdom stamps an event with Date.now().
    const at = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fireEvent.wheel(screen.getByRole('tabpanel'), { deltaX: 25, deltaY: 0 });
    at.mockReturnValue(1_002_000);
    fireEvent.wheel(screen.getByRole('tabpanel'), { deltaX: 25, deltaY: 0 });
    expect(page()).toBe('在做');
  });

  it('steps the banner by its arrows, names the shell components with their state and closes the window', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    mount();
    const first = await screen.findByRole('button', { name: /^(提醒|交付)：/ }, { timeout: 3000 });
    const label = first.getAttribute('aria-label');
    fireEvent.click(screen.getByRole('button', { name: '下一条' }));
    expect(screen.getByRole('button', { name: /^(提醒|交付)：/ }).getAttribute('aria-label')).not.toBe(label);
    fireEvent.click(screen.getByRole('button', { name: '上一条' }));
    expect(screen.getByRole('button', { name: /^(提醒|交付)：/ }).getAttribute('aria-label')).toBe(label);
    const status = await screen.findByRole('group', { name: '组件状态' });
    expect(status.textContent).toMatch(/^后台.+角色.+语音/);
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('puts the outfit she wears and the renderer frame rate on the character card', async () => {
    const b = getBridge();
    vi.spyOn(b.character, 'list').mockResolvedValue([
      { id: 'si', name: '祀', en: 'SI', active: true, voice: true, appearances: [{ id: 'daily', name: '日常', desc: '' }, { id: 'uniform', name: '制服', desc: '' }] },
    ]);
    vi.spyOn(b.avatar, 'state').mockResolvedValue({ ...(await b.avatar.state()), appearanceId: 'uniform' });
    vi.spyOn(b.avatar, 'onStats').mockImplementation((cb) => {
      queueMicrotask(() => cb({ fps: 59.6, frameMs: 16.8, cpuPercent: 10 }));
      return () => {};
    });
    mount();
    const card = await screen.findByRole('button', { name: /^角色：/ });
    await vi.waitFor(() => expect(card.textContent).toMatch(/制服.*60 FPS/));
    // The frame rate is a developer reading: outside 开发者模式 the card keeps the outfit alone.
    cleanup();
    setDevMode(false);
    mount();
    const plain = await screen.findByRole('button', { name: /^角色：/ });
    await vi.waitFor(() => expect(plain.textContent).toContain('制服'));
    expect(plain.textContent).not.toContain('FPS');
  });

  it('counts no failed run as done on the task plaque, and shows no plaque before the runs are read', async () => {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    const read = async () => (await screen.findByRole('button', { name: /^今日任务 完成 \d+ \/ \d+$/ }, { timeout: 3000 })).getAttribute('aria-label')!.match(/(\d+) \/ (\d+)$/)!.slice(1).map(Number);
    mount();
    const [done, total] = await read();
    expect(done).toBeGreaterThan(0);
    cleanup();
    const failing = vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      // A copy: the fake bridge hands out its shared fixtures.
      const r = structuredClone(await real(method, path, body)) as { status: number; body: { runs?: Array<{ ended_at: number | null; state: string }> } };
      if (path.startsWith('/agent/runs')) for (const run of r.body.runs ?? []) if (run.ended_at != null) run.state = 'failed';
      return r as never;
    });
    mount();
    expect(await read()).toEqual([0, total]);
    cleanup();
    failing.mockRestore();
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
      path.startsWith('/agent/runs') ? new Promise<never>(() => {}) : await real(method, path, body),
    );
    mount();
    await screen.findByRole('button', { name: /^待处理 \d+$/ }, { timeout: 3000 });
    expect(screen.queryByRole('button', { name: /^今日任务/ })).toBeNull();
  });

  it('shows dashes while reading and zeros on an empty day', async () => {
    mount('&state=loading');
    expect(await screen.findAllByRole('button', { name: /^待处理 —$/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^今日任务/ })).toBeNull();
    expect(screen.getByText('读取中')).toBeTruthy();
    cleanup();
    mount('&state=empty');
    expect(await screen.findAllByRole('button', { name: '待处理 0' }, { timeout: 3000 })).toHaveLength(1);
    expect(await screen.findByRole('button', { name: '今日任务 完成 0 / 0' })).toBeTruthy();
    expect(screen.queryAllByRole('group', { name: /^(审批|提问|复核)：/ })).toEqual([]);
    expect(screen.getByText('没有要你批准的事')).toBeTruthy();
  });
});

describe('home geometry', () => {
  const boxes = (): Array<[string, Box]> => [
    ...leftTiles(4).map((k, i): [string, Box] => [`left ${i}`, k.box]),
    ...rightTiles(10).map((b, i): [string, Box] => [`right ${i}`, b]),
    ...TOP_ICONS.map((b, i): [string, Box] => [`top ${i}`, b]),
    ['card', CARD],
    ...BAR_SLOTS.map((k, i): [string, Box] => [`slot ${i}`, k.box]),
    ['counters', COUNTERS],
    ['banner', BANNER],
  ];

  it('keeps the keys, the top icons, the character card, the bar slots, the clock strip and the banner on the stage', () => {
    for (const [, b] of boxes()) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(STAGE.w);
      expect(b.top + b.height).toBeLessThanOrEqual(STAGE.h);
    }
  });

  it('lets no two of them overlap, and keeps the outline of each left key inside its box', () => {
    const all = boxes().filter(([name]) => !name.startsWith('slot'));
    const hit = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
    const overlaps = all.flatMap(([n, a], i) => all.slice(i + 1).filter(([, b]) => hit(a, b)).map(([m]) => `${n} × ${m}`));
    expect(overlaps).toEqual([]);
    for (const k of leftTiles(4)) {
      for (const [x, y] of k.pts) {
        expect(x).toBeGreaterThanOrEqual(-0.1);
        expect(y).toBeGreaterThanOrEqual(-0.1);
        expect(x).toBeLessThanOrEqual(k.box.width + 0.1);
        expect(y).toBeLessThanOrEqual(k.box.height + 0.1);
      }
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
  });
});

describe('home with the plug-ins at their defaults', () => {
  beforeEach(() => {
    pluginsReset();
    setDevMode(false);
  });

  it('keeps only 角色, 对话, 记忆 and 设置 among the pages, and no 待处理, 提醒, 派发任务, 屏幕识读, 每日简报 or report', async () => {
    mount();
    expect(names(await screen.findByRole('group', { name: '主要页面' }))).toEqual(LEFT('character', 'chat', 'memory'));
    expect(names(screen.getByRole('group', { name: '工具' }))).toEqual(['搜索', '快速输入', '停止说话']);
    expect(screen.getByRole('button', { name: title('settings') })).toBeTruthy();
    for (const gone of [/^待处理/, /^提醒$/, /^提醒：/, /^交付：/, '没有新消息', /^派发任务$/, /^屏幕识读$/, new RegExp(`^${title('overview')}$`), /^今日任务/]) expect(screen.queryByRole('button', { name: gone })).toBeNull();
    expect(screen.getByRole('button', { name: '打开对话' })).toBeTruthy();
    // The bar's glow band lies under the one slot left, not under the empty 每日简报 slot.
    const band = document.querySelector<HTMLElement>('[data-g="hudBar"] > span[aria-hidden="true"]')!;
    expect([band.style.left, band.style.width]).toEqual([`${BAR_SLOTS[0].box.left}px`, `${BAR_SLOTS[0].box.width}px`]);
  });

  it('sends none of the today reads with 日报与简报 off, and 后台 reads /health, not them', async () => {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    const paths: string[] = [];
    // As agentd: a plug-in's routes answer 409 plugin_off while it is off; /agent/snapshot stands for the overview's reads.
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      paths.push(path.split('?')[0]!);
      return (TODAY_READS.includes(path.split('?')[0]!) ? { status: 409, body: { error: 'plugin_off' } } : await real(method, path, body)) as never;
    });
    mount();
    const status = await screen.findByRole('group', { name: '组件状态' });
    await vi.waitFor(() => expect(status.textContent).toMatch(/^后台运行中/));
    expect(paths).toContain('/health');
    expect(paths.filter((p) => TODAY_READS.includes(p))).toEqual([]);
    expect(within(status).queryByText('读取失败')).toBeNull();
  });

  it('says the connection once, on 后台: a failed read shows there and the clock carries only the time and date', async () => {
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
      (path.split('?')[0] === '/health' ? { status: 503, body: { error: 'down' } } : await real(method, path, body)) as never,
    );
    mount();
    const status = await screen.findByRole('group', { name: '组件状态' });
    await vi.waitFor(() => expect(status.textContent).toMatch(/^后台读取失败/));
    const clock = screen.getByRole('group', { name: '时钟' });
    for (const word of ['已连接', '读取中', '读取失败']) expect(within(clock).queryByText(word)).toBeNull();
  });

  it('offers 派发任务 with 个人代理 on and 日报与简报 off, and opens the dispatch dialog in place', async () => {
    pluginsOn('personal_agent');
    mount();
    expect(names(await screen.findByRole('group', { name: '工具' }))).toEqual(['派发任务', '搜索', '快速输入', '停止说话']);
    fireEvent.click(screen.getByRole('button', { name: '派发任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建' });
    expect(within(dialog).getByRole('button', { name: /交派/ })).toBeTruthy();
    expect(window.location.hash).not.toMatch(/overview/);
  });

  it('adds 待处理, 提醒, 每日简报 and the report once 日报与简报 is on, and 派发任务 once 个人代理 is on too', async () => {
    pluginsOn('daily_brief');
    mount();
    expect(await screen.findByRole('button', { name: /^待处理 / })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提醒' })).toBeTruthy();
    expect(screen.getByRole('button', { name: title('overview') })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^今日任务/ }, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '派发任务' })).toBeNull();
    cleanup();
    pluginsOn('daily_brief', 'personal_agent', 'screen_reading');
    mount();
    expect(names(await screen.findByRole('group', { name: '工具' }))).toEqual(ACTIONS);
    expect(names(screen.getByRole('group', { name: '主要页面' }))).toEqual(LEFT('character', 'chat', 'memory', 'tasks'));
  });

  it('writes 待处理 with its count and 提醒 under their icons', async () => {
    pluginsOn('daily_brief');
    mount('&state=empty');
    for (const b of [await screen.findByRole('button', { name: '待处理 0' }, { timeout: 3000 }), screen.getByRole('button', { name: '提醒' })]) {
      expect(b.textContent).toBe(b.getAttribute('aria-label'));
    }
  });

  it('the report counts no 在做 while neither 编码会话 nor 个人代理 is on', async () => {
    pluginsOn('daily_brief');
    mount('&state=empty');
    expect((await screen.findByRole('button', { name: /^今日任务/ }, { timeout: 3000 })).textContent).not.toContain('在做');
    cleanup();
    pluginsOn('daily_brief', 'coding_sessions');
    mount('&state=empty');
    expect((await screen.findByRole('button', { name: /^今日任务/ }, { timeout: 3000 })).textContent).toContain('在做 0');
  });
});
