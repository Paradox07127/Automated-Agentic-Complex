// The developer 调参 page: 行为 (state plate, state and decisions on one axis, causes, reset) and 画质 (render load, the three dev quality rows).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse } from '../../src/bridge/protocol';
import { WIRE_STATE_WITH_CAUSES } from '../../src/mock/character';
import { CharacterPage } from '../../src/pages/character/Page';
import { findRoute } from '../../src/shell/registry';
import { createAppRouter } from '../../src/shell/router';
import { TuneSlot } from '../../src/surfaces/desktop/cmd/tune/TuneSlot';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
  vi.restoreAllMocks();
});

function mount(component: RouteComponent, search = '') {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function install() {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  return bridge;
}

const tune = (search = '') => mount(findRoute('/tune')!.component, search);
const click = (el: Element) => act(async () => void fireEvent.click(el));

describe(' 调参 · 行为', () => {
  it('draws the state plate, one chart for the curves and the three decision lanes, and the causes; no motion table', async () => {
    expect(findRoute('/tune')?.devOnly).toBe(true);
    tune();
    const plate = await screen.findByRole('region', { name: '她现在的状态' });
    await waitFor(() => expect(plate.textContent).toContain('有点低落'));
    expect(plate.textContent).toContain('坐着');
    expect(plate.textContent).toContain('状态影响行为 开');
    const chart = screen.getByRole('region', { name: '精神与心情 │ 行为决策' });
    expect(within(chart).getByRole('img', { name: /^精神和心情曲线，下面是同一时间轴上的行为决策/ })).toBeTruthy();
    await waitFor(() => expect(chart.querySelector('svg')?.textContent).toContain('规则 1'));
    expect(chart.querySelector('svg')?.textContent).toContain('模型 0');
    expect(chart.querySelector('svg')?.textContent).toContain('硬规则 0');
    expect(within(screen.getByRole('region', { name: '变化原因' })).getAllByRole('button')).toHaveLength(8);
    expect(screen.queryByRole('grid', { name: '全部动作' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '活动方式' })).toBeNull();
    expect(screen.queryByText('状态倍数')).toBeNull();
  });

  it('shows her energy, mood and engagement codes as their Chinese words', async () => {
    const bridge = install();
    const inner = bridge.agentd.request.bind(bridge.agentd);
    const state = { ...WIRE_STATE_WITH_CAUSES, labels: { energy: 'very_sleepy', mood: 'good', engagement: 'some' } };
    bridge.agentd.request = (async (method: string, path: string, body?: unknown) =>
      method === 'GET' && path === '/character/state' ? { status: 200, body: state } : inner(method as never, path, body)) as typeof bridge.agentd.request;
    tune();
    const plate = await screen.findByRole('region', { name: '她现在的状态' });
    await waitFor(() => expect(plate.textContent).toContain('很困'));
    expect(plate.textContent).toContain('不错');
    expect(plate.textContent).toContain('一般');
    expect(plate.textContent).not.toMatch(/very_sleepy|good/);
  });

  it('a cause pins the cursor and the line under the chart reads it', async () => {
    tune();
    const list = await screen.findByRole('region', { name: '变化原因' });
    const first = within(list).getAllByRole('button')[0]!;
    await click(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    const cause = first.textContent ?? '';
    const line = screen.getByRole('region', { name: '精神与心情 │ 行为决策' }).querySelector('[aria-live]');
    expect(cause).toContain('和你聊天');
    expect(line?.textContent).toContain('和你聊天');
    expect(line?.textContent).toMatch(/当时精神 \d\.\d\d/);
  });

  it('reads the decisions from the start of today, or from 24 hours ago', async () => {
    const bridge = install();
    const request = vi.spyOn(bridge.agentd, 'request');
    tune();
    const since = () => request.mock.calls.map(([, p]) => p).filter((p) => p.startsWith('/trace/decisions')).map((p) => new URLSearchParams(p.split('?')[1]).get('since'));
    await waitFor(() => expect(since()).toHaveLength(1));
    expect(new Date(since()[0]!).getHours()).toBe(0);
    await click(screen.getByRole('radio', { name: '24 小时' }));
    await waitFor(() => expect(since()).toHaveLength(2));
    expect(Date.parse(since()[0]!) - Date.parse(since()[1]!)).toBeGreaterThan(0);
  });

  it('重置状态… asks first, then sends DELETE /character/state', async () => {
    const bridge = install();
    const request = vi.spyOn(bridge.agentd, 'request');
    tune();
    await screen.findByText('有点低落');
    await click(screen.getByRole('button', { name: '重置状态…' }));
    const dialog = screen.getByRole('dialog', { name: '重置角色的状态？' });
    expect(dialog.textContent).toContain('变化原因：8 条');
    await click(within(dialog).getByRole('button', { name: '重置' }));
    await waitFor(() => expect(request.mock.calls.some(([m, p]) => m === 'DELETE' && p === '/character/state')).toBe(true));
    await waitFor(() => expect(screen.getByRole('region', { name: '她现在的状态' }).textContent).toContain('平稳'));
  });

  it('without a state the reset is off and the chart says why', async () => {
    window.location.hash = '#/tune?demo=state-none';
    tune('&demo=state-none');
    expect(await screen.findByText(/状态还没开始记录/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重置状态…' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe(' 调参 · 画质', () => {
  it('has only the three developer rows, saves each on click and keeps her clear of the window while open', async () => {
    const bridge = install();
    const save = vi.spyOn(bridge.settings, 'save').mockResolvedValue({ restart: 'avatar', notApplied: [] });
    const clear = vi.spyOn(bridge.avatar, 'keepClearOfMain');
    const ui = tune('&tab=render');
    const shadow = await screen.findByRole('radiogroup', { name: '自阴影精度' });
    expect(screen.getByRole('radiogroup', { name: '2× SSAA' })).toBeTruthy();
    expect(within(screen.getByRole('radiogroup', { name: '渲染尺寸' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['原始尺寸', '跟随显示']);
    expect(screen.queryByRole('radiogroup', { name: '原作镜头预设' })).toBeNull();
    expect(clear).toHaveBeenLastCalledWith(true);
    await click(within(shadow).getByRole('radio', { name: '低 · 256' }));
    expect(save).toHaveBeenLastCalledWith({ 'rnd.shadow': '256' });
    await waitFor(() => expect(screen.getByText('默认：高 · 1024')).toBeTruthy());
    const all = screen.getByRole('button', { name: '恢复默认（1）' });
    await click(all);
    expect(save).toHaveBeenLastCalledWith({ 'rnd.shadow': '1024' });
    ui.unmount();
    expect(clear).toHaveBeenLastCalledWith(false);
  });

  it('the tabs switch between 行为 and 画质', async () => {
    tune();
    await screen.findByRole('region', { name: '她现在的状态' });
    await click(screen.getByRole('tab', { name: '画质' }));
    expect(await screen.findByRole('radiogroup', { name: '自阴影精度' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '画质' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('region', { name: '她现在的状态' })).toBeNull();
  });

  it('a failed settings read says why instead of showing made-up values', async () => {
    const bridge = install();
    vi.spyOn(bridge.settings, 'read').mockRejectedValue({ code: 'config_unreadable', detail: 'config.json' });
    tune('&tab=render');
    expect(await screen.findByText(/读取设置失败/)).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '自阴影精度' })).toBeNull();
  });

  it('角色未运行: the rows are read-only and the bottom bar restarts her', async () => {
    window.location.hash = '#/tune?demo=offline&tab=render';
    tune('&demo=offline&tab=render');
    const shadow = await screen.findByRole('radiogroup', { name: '自阴影精度' });
    expect(within(shadow).getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole('button', { name: '重启角色' })).toBeTruthy();
    expect(screen.getByText(/角色未运行 │ 没有读数/)).toBeTruthy();
  });
});

describe(' 调参 route', () => {
  it('#/character?tab=render stays on /character', async () => {
    const router = createAppRouter();
    router.history.push('/character?tab=render&still=1');
    await router.load();
    expect(router.state.location.pathname).toBe('/character');
    expect(router.state.location.search).toMatchObject({ tab: 'render', still: 1 });
  });
});

describe(' 角色 page after 调参 moved out', () => {
  it('has no state curves and no view tabs, and its motion table shows timing and trigger beside the switches', async () => {
    window.location.hash = '#/character?still=1';
    mount(CharacterPage, '&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    const nod = await waitFor(() => grid.querySelector('[data-motion="nod"]') as HTMLElement);
    expect(within(nod).getByRole('radiogroup', { name: '点头附和' })).toBeTruthy();
    expect(nod.textContent).toContain('批准之后');
    expect(nod.textContent).toMatch(/\d\.\ds/);
    expect(screen.queryByRole('region', { name: '状态与行为决策' })).toBeNull();
    expect(screen.queryByRole('img', { name: /^精神和心情/ })).toBeNull();
    expect(screen.queryByRole('tablist', { name: '角色视图' })).toBeNull();
  });
});

describe('desktop 镜头与动作 · 动作来源', () => {
  type Saved = { backend: string; service_url: string | null; token_set: boolean };

  /** A stack fake bridge whose `/motion/settings` answers `saved` on GET and `reply` (or the body it got) on PUT; returns the PUT bodies. */
  function mountSlot(saved: Saved, reply?: AgentdResponse<unknown>, failedReads = 0) {
    const bridge = createFakeBridge({ surface: 'stack', still: true });
    const inner = bridge.agentd.request.bind(bridge.agentd);
    const puts: unknown[] = [];
    bridge.agentd.request = (async (method: string, path: string, body?: unknown) => {
      if (path !== '/motion/settings') return inner(method as never, path, body);
      if (method === 'GET' && failedReads-- > 0) return { status: 503, body: { error: 'no_motion' }, error: { code: 'no_motion' } };
      if (method === 'GET') return { status: 200, body: saved };
      puts.push(body);
      const b = body as { backend: string; service_url: string | null; token?: string };
      return reply ?? { status: 200, body: { backend: b.backend, service_url: b.service_url, token_set: b.token === undefined ? saved.token_set : b.token !== '' } };
    }) as typeof bridge.agentd.request;
    window.agenticComplex = bridge;
    render(<TuneSlot anchor={null} presence={null} state={null} close={() => {}} />);
    return puts;
  }

  const fold = () => screen.getByRole('button', { name: /^动作来源/ });
  /** Waits for the closed fold's summary; the fold remembers it was open across mounts. */
  const summary = async (text: string) => {
    if (fold().getAttribute('aria-expanded') === 'true') fireEvent.click(fold());
    await waitFor(() => expect(fold().textContent).toContain(text));
  };
  const open = async (text: string) => {
    await summary(text);
    fireEvent.click(fold());
  };

  it('reads the saved source into the summary and the fields', async () => {
    mountSlot({ backend: 'generated', service_url: 'http://10.0.0.2:48830', token_set: true });
    expect(screen.getByRole('dialog', { name: '角色 │ 镜头与动作' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '镜头与动作' })).toBeTruthy();
    await open('模型生成');
    expect(screen.getByRole('radio', { name: '模型生成' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('textbox', { name: '动作服务地址' }) as HTMLInputElement).value).toBe('http://10.0.0.2:48830');
    expect(screen.getByPlaceholderText('已保存口令')).toBeTruthy();
    expect(screen.getByText('模型生成：她按自己说的话生成动作，连不上服务时自动用游戏动作。')).toBeTruthy();
  });

  it('says 未连接服务 when generated has no address', async () => {
    mountSlot({ backend: 'generated', service_url: null, token_set: false });
    await summary('模型生成 │ 未连接服务');
  });

  it('模型生成 without an address cannot be saved', async () => {
    const puts = mountSlot({ backend: 'game', service_url: null, token_set: false });
    await open('游戏动作');
    fireEvent.click(screen.getByRole('radio', { name: '模型生成' }));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.getAttribute('title')).toBe('先填动作服务地址');
    fireEvent.click(save);
    expect(puts).toEqual([]);
  });

  it('saves backend and address, leaving token out when its field is empty', async () => {
    const puts = mountSlot({ backend: 'game', service_url: null, token_set: true });
    await open('游戏动作');
    fireEvent.click(screen.getByRole('radio', { name: '模型生成' }));
    fireEvent.change(screen.getByRole('textbox', { name: '动作服务地址' }), { target: { value: 'http://192.168.1.199:48830' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(puts).toEqual([{ backend: 'generated', service_url: 'http://192.168.1.199:48830' }]));
    fireEvent.change(screen.getByLabelText('口令'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(puts[1]).toEqual({ backend: 'generated', service_url: 'http://192.168.1.199:48830', token: 's3cret' }));
  });

  it('shows invalid_service_url in Chinese', async () => {
    mountSlot({ backend: 'game', service_url: null, token_set: false }, { status: 400, body: { error: 'invalid_service_url' }, error: { code: 'invalid_service_url' } });
    await open('游戏动作');
    fireEvent.change(screen.getByRole('textbox', { name: '动作服务地址' }), { target: { value: 'ftp://x' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findByRole('status')).textContent).toBe('地址要以 http:// 或 https:// 开头');
  });

  it('a failed read says so, keeps 保存 off and 重新读取 brings the saved source', async () => {
    const puts = mountSlot({ backend: 'generated', service_url: 'http://10.0.0.2:48830', token_set: false }, undefined, 1);
    await open('读取失败');
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.getAttribute('title')).toBe('动作来源没读到，先重新读取');
    fireEvent.click(save);
    expect(puts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await summary('模型生成');
  });

  it('清除 sends token ""', async () => {
    const puts = mountSlot({ backend: 'generated', service_url: 'http://10.0.0.2:48830', token_set: true });
    await open('模型生成');
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => expect(puts).toEqual([{ backend: 'generated', service_url: 'http://10.0.0.2:48830', token: '' }]));
    await waitFor(() => expect(screen.getByLabelText('口令').getAttribute('placeholder')).not.toBe('已保存口令'));
  });
});
