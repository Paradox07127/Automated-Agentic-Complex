// Character page on the native ops: avatar.actions, avatar.onStats, settings.* (rnd.* / beh.*), supervisor backoff, switch and import receipts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarStats, AgenticComplexBridge, SettingsSaveResult } from '../../src/bridge/protocol';
import { DEMO_SCHEMA } from '../../src/mock/settings';
import { CharacterPage } from '../../src/pages/character/Page';
import { TunePage } from '../../src/pages/tune/Page';
import { setNavRouter } from '../../src/shell/nav';
import { toast as pushToast } from '../../src/shell/toast';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
// The 动作 pane draws the chain graph.
vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

let bridge: AgenticComplexBridge;
let request: MockInstance<AgenticComplexBridge['agentd']['request']>;
const toasts = () => vi.mocked(pushToast).mock.calls.map((c) => c[0]);

function install(over: Partial<AgenticComplexBridge> = {}) {
  bridge = { ...createFakeBridge({ surface: 'main', still: true }), ...over };
  window.agenticComplex = bridge;
  request = vi.spyOn(bridge.agentd, 'request');
}

async function mount(search = '', component: RouteComponent = CharacterPage) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-page]')).not.toBeNull());
}

/** 行为与画面 lives on the developer 调参 page. */
const tune = () => mount('', TunePage);

const gets = (): string[] => request.mock.calls.filter(([m]) => m === 'GET').map(([, p]) => p);
const click = (el: Element) => act(async () => void fireEvent.click(el));

beforeEach(() => {
  vi.mocked(pushToast).mockClear();
  install();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('motions', () => {
  it('lists avatar.actions() and never reads a /character/motions route', async () => {
    const actions = vi.spyOn(bridge.avatar, 'actions');
    await mount('&pane=motion');
    expect((await screen.findAllByText('点头附和')).length).toBeGreaterThan(0);
    expect(actions).toHaveBeenCalled();
    expect(gets().filter((p) => p.startsWith('/character/motions'))).toEqual([]);
  });

  it('waits for a late avatar.actions() instead of showing the empty section', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => (await gate, real()));
    await mount('&pane=motion');
    await waitFor(() => expect(screen.queryByText('读取中')).toBeNull());
    expect(screen.queryByText('这个分区没有启用的动作')).toBeNull();
    // The table's place holds a skeleton; the page's one 读取中 is gone from the header.
    expect(document.querySelector('[data-stub="Skel"]')).not.toBeNull();
    await act(async () => release());
    expect((await screen.findAllByText('点头附和')).length).toBeGreaterThan(0);
    expect(screen.queryByText('这个分区没有启用的动作')).toBeNull();
  });

  it('a failed avatar.actions() says why and retries', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    const actions = vi.spyOn(bridge.avatar, 'actions').mockRejectedValueOnce({ code: 'not_ready', detail: 'avatar' });
    await mount('&pane=motion');
    await waitFor(() => expect(screen.queryByText('读取中')).toBeNull());
    expect(screen.queryByText('这个分区没有启用的动作')).toBeNull();
    const bar = await screen.findByRole('alert');
    expect(bar.textContent).toContain('读取动作失败');
    expect(screen.queryByText('这个分区没有启用的动作')).toBeNull();
    actions.mockImplementation(real);
    await click(within(bar).getByRole('button', { name: /重试/ }));
    expect((await screen.findAllByText('点头附和')).length).toBeGreaterThan(0);
  });
});

describe('render readings', () => {
  it('draws avatar.onStats (fps, P95, GPU) and never reads /character/render', async () => {
    let push: ((s: AvatarStats) => void) | null = null;
    const off = vi.fn();
    vi.spyOn(bridge.avatar, 'onStats').mockImplementation((cb) => ((push = cb), off));
    await tune();
    await waitFor(() => expect(push).not.toBeNull());
    expect(await screen.findByText(/还没有收到宿主读数/)).toBeTruthy();
    act(() => push?.({ fps: 58, frameMsP95: 15.24, gpuMs: 6.1, frameMs: 17.2, cpuPercent: 12 }));
    const fps = await screen.findByText('FPS');
    const row = fps.parentElement?.parentElement as HTMLElement;
    expect(row.textContent).toContain('58');
    expect(row.textContent).toContain('15.2 ms');
    expect(row.textContent).toContain('6.1 ms');
    expect(gets().filter((p) => p.startsWith('/character/render'))).toEqual([]);
    cleanup();
    expect(off).toHaveBeenCalled();
  });
});

describe('render settings (rnd.*)', () => {
  it('shows only schema rows with schema options and saves each change by option value through settings.save', async () => {
    const save = vi.spyOn(bridge.settings, 'save').mockResolvedValue({ restart: 'avatar', notApplied: [] });
    const present = vi.spyOn(bridge.avatar.presentation, 'set');
    await tune();
    const cam = await screen.findByRole('radiogroup', { name: '镜头预设' });
    expect(within(cam).getAllByRole('radio').map((r) => r.textContent)).toEqual(['角色展示', '总览', '档案']);
    expect(screen.queryByText('跟随时间')).toBeNull();
    await click(within(cam).getByRole('radio', { name: '总览' }));
    expect(save).toHaveBeenLastCalledWith({ 'rnd.cam': 'overview' });
    await click(within(screen.getByRole('radiogroup', { name: '自阴影精度' })).getByRole('radio', { name: '低 · 256' }));
    expect(save).toHaveBeenLastCalledWith({ 'rnd.shadow': '256' });
    expect(present).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['已保存 │ 角色正在重新出现', '已保存 │ 角色正在重新出现']);
  });

  it('says the save was refused and keeps the saved value', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(bridge.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: [], error: '「渲染尺寸」不能设成 x' } as SettingsSaveResult);
    await tune();
    const cam = await screen.findByRole('radiogroup', { name: '镜头预设' });
    await click(within(cam).getByRole('radio', { name: '档案' }));
    expect(toasts()).toEqual(['没有保存「原作镜头预设」：桌面端没有接受这次修改']);
    expect(within(cam).getByRole('radio', { name: '角色展示' }).getAttribute('aria-checked')).toBe('true');
  });

  it('a raw shell error (option key, system text) goes to the log, the toast stays fixed Chinese', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(bridge.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: [], error: 'authored: The file couldn’t be saved.' } as SettingsSaveResult);
    await tune();
    await click(within(await screen.findByRole('radiogroup', { name: '镜头预设' })).getByRole('radio', { name: '档案' }));
    expect(toasts()).toEqual(['没有保存「原作镜头预设」：桌面端没有接受这次修改']);
    expect(warn.mock.calls.flat().join(' ')).toContain('authored: The file couldn’t be saved.');
  });

  it('drops a control the schema does not have', async () => {
    vi.spyOn(bridge.settings, 'schema').mockResolvedValue(DEMO_SCHEMA.filter((r) => r.id !== 'rnd.outline'));
    await tune();
    await screen.findByRole('radiogroup', { name: '镜头预设' });
    expect(screen.queryByText('角色边界')).toBeNull();
    expect(screen.getByText('主光强度')).toBeTruthy();
  });
});

describe('behavior settings (beh.*)', () => {
  it('saves each row by its beh.* id and says the receipt', async () => {
    const save = vi.spyOn(bridge.settings, 'save').mockResolvedValueOnce({ restart: 'none', notApplied: [] }).mockResolvedValueOnce({ restart: 'avatar', notApplied: [] });
    await tune();
    await click(await screen.findByRole('switch', { name: '看向鼠标' }));
    expect(save).toHaveBeenLastCalledWith({ 'beh.mouse': false });
    await click(within(screen.getByRole('radiogroup', { name: '活动范围' })).getByRole('radio', { name: '小窗口' }));
    expect(save).toHaveBeenLastCalledWith({ 'beh.range': 'window' });
    expect(toasts()).toEqual(['已保存 │ 立即生效', '已保存 │ 角色正在重新出现']);
    expect(screen.queryByText('悬停变淡')).toBeNull();
  });

  it('greys out a capability whose motion the package lacks and says which', async () => {
    await tune();
    // The first is the capability; the full motion table below has a 扶着窗沿 switch of its own.
    const lean = (await screen.findAllByRole('switch', { name: /扶着窗沿/ }))[0]!;
    expect((lean as HTMLButtonElement).disabled).toBe(true);
    expect(lean.parentElement?.textContent).toContain('不可用 │ 缺少 lean_02');
  });

  it('a failed read says why instead of showing made-up values', async () => {
    vi.spyOn(bridge.settings, 'read').mockRejectedValue({ code: 'config_unreadable', detail: 'config.json' });
    await tune();
    expect(await screen.findByText(/读取设置失败/)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '看向鼠标' })).toBeNull();
  });
});

describe('offline note', () => {
  it('says the supervisor backoff from supervisor.state', async () => {
    vi.spyOn(bridge.supervisor, 'state').mockResolvedValue({ agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'backoff(8)', pid: null, backoff: 8 } });
    await mount();
    expect((await screen.findByText(/退避/)).closest('[role="status"]')?.textContent).toContain('退避 8 秒后重试');
  });
});

describe('import receipts', () => {
  it('has 导入角色 on the 导入 pane opened from 动作, not on the 外观 导入 tab nor in the header', async () => {
    await mount('&pane=look');
    expect(screen.queryByRole('button', { name: '导入角色' })).toBeNull();
    // The 外观 导入 tab imports outfit mods only.
    await click(await screen.findByRole('tab', { name: '导入' }));
    await screen.findByRole('heading', { name: '导入外观模组' });
    expect(screen.queryByRole('button', { name: '导入角色' })).toBeNull();
    cleanup();
    await mount('&pane=import');
    expect(within(await screen.findByRole('region', { name: '角色' })).getByRole('button', { name: '导入角色' })).toBeTruthy();
  });

  it('says each import outcome in Chinese; cancelling is not an error', async () => {
    const imp = vi.spyOn(bridge.character, 'importPackage');
    imp.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'cancelled' }).mockResolvedValueOnce({ ok: false, reason: '未配置 Metal 宿主可执行文件' }).mockResolvedValueOnce({ ok: false, reason: 'bundle hash mismatch' });
    await mount('&pane=import');
    for (let i = 0; i < 4; i++) await click(await screen.findByRole('button', { name: '导入角色' }));
    expect(toasts()).toEqual(['已导入角色', '已取消导入', '导入没有完成：未配置 Metal 宿主可执行文件', '导入没有完成：桌面角色没有给出原因']);
    expect(vi.mocked(pushToast).mock.calls[1]?.[1]?.severity).toBeUndefined();
  });
});

describe('motion import', () => {
  const line = () => document.querySelector('[data-motion-import]')?.textContent ?? '';

  it('says 导入中… and stays disabled while the import runs, then names the action and refetches the motions', async () => {
    let finish: (r: Awaited<ReturnType<AgenticComplexBridge['character']['importMotion']>>) => void = () => {};
    vi.spyOn(bridge.character, 'importMotion').mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const actions = vi.spyOn(bridge.avatar, 'actions');
    await mount('&pane=import');
    await waitFor(() => expect(actions).toHaveBeenCalled());
    const reads = actions.mock.calls.length;
    await click(screen.getByRole('button', { name: '导入动作' }));
    expect(screen.getByRole('button', { name: '导入中…' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => finish({ ok: true, action: { id: 'vmd_dance', title: '极乐净土', durationS: 12.5, hasBgm: false, format: 'vmd', warnings: [] } }));
    expect(screen.getByRole('button', { name: '导入动作' }).getAttribute('aria-disabled')).toBeNull();
    expect(line()).toBe('已导入「极乐净土」（VMD）');
    await waitFor(() => expect(actions.mock.calls.length).toBeGreaterThan(reads));
  });

  it('says each failure in Chinese and shows the detail of an internal one', async () => {
    vi.spyOn(bridge.character, 'importMotion')
      .mockResolvedValueOnce({ ok: false, reason: 'too_many_actions', detail: 'si already has 128 action rows' })
      .mockResolvedValueOnce({ ok: false, reason: 'internal', detail: 'unknown_character: cedar' });
    await mount('&pane=import');
    await click(await screen.findByRole('button', { name: '导入动作' }));
    expect(line()).toBe('导入没有完成：动作已满 128 条');
    await click(screen.getByRole('button', { name: '导入动作' }));
    expect(line()).toBe('导入没有完成：unknown_character: cedar');
  });

  it('names the format and counts the warnings of a non-VMD import', async () => {
    vi.spyOn(bridge.character, 'importMotion').mockResolvedValueOnce({ ok: true, action: { id: 'bvh_walk', title: 'walk', durationS: 3, hasBgm: false, format: 'bvh', warnings: ['fingers_rest'] } });
    await mount('&pane=import');
    await click(await screen.findByRole('button', { name: '导入动作' }));
    expect(line()).toContain('（BVH）');
    expect(line()).toContain('有 1 条提示');
  });

  it('a cancelled pick says nothing', async () => {
    vi.spyOn(bridge.character, 'importMotion').mockResolvedValueOnce({ ok: true, action: { id: 'vmd_dance', title: '极乐净土', durationS: 12.5, hasBgm: false, format: 'vmd', warnings: [] } }).mockResolvedValueOnce({ ok: false, reason: 'cancelled' });
    await mount('&pane=import');
    await click(await screen.findByRole('button', { name: '导入动作' }));
    await click(screen.getByRole('button', { name: '导入动作' }));
    expect(document.querySelector('[data-motion-import]')).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it('plays an imported action with BGM at 1× only', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.character, 'importMotion').mockResolvedValueOnce({ ok: true, action: { id: 'vmd_dance', title: '极乐净土', durationS: 12.5, hasBgm: true, format: 'vmd', warnings: [] } });
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { id: 'vmd_dance', label: '极乐净土', enabled: true, section: 'idle', durationS: 12.5, playable: true }]);
    vi.spyOn(bridge.character, 'listImportedMotions').mockResolvedValue({
      ok: true,
      motions: [{ id: 'vmd_dance', clip: 'imported_vmd_dance', title: '极乐净土', format: 'vmd', durationS: 12.5, hasBgm: true, createdAt: null, warnings: [] }],
    });
    await mount('&pane=import');
    await click(await screen.findByRole('button', { name: '导入动作' }));
    await click(screen.getByRole('tab', { name: '动作表' }));
    await waitFor(() => expect(document.querySelector('[data-motion="vmd_dance"]')).not.toBeNull());
    await click(document.querySelector('[data-motion="vmd_dance"]')!);
    const speed = screen.getByRole('radiogroup', { name: '播放速度' });
    expect(within(speed).getByRole('radio', { name: '1×' }).getAttribute('aria-checked')).toBe('true');
    expect(within(speed).getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
  });
});
