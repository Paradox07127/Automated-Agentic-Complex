// The developer 调参 page (behavior, render, the state curves, the full motion table); 角色 keeps the profile and a compact motion table.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse } from '../../src/bridge/protocol';
import { STATE_WITH_CAUSES } from '../../src/mock/character';
import { DEMO_SCHEMA } from '../../src/mock/settings';
import { CharacterPage } from '../../src/pages/character/Page';
import { TuneBehavior } from '../../src/pages/character/TuneBehavior';
import { findRoute } from '../../src/shell/registry';
import { createAppRouter } from '../../src/shell/router';
import { TuneSlot } from '../../src/surfaces/desktop/cmd/tune/TuneSlot';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

function mount(component: RouteComponent, search = '') {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe(' 调参 page', () => {
  it('/tune draws behavior, render and the state curves, with the full motion table', async () => {
    const tune = findRoute('/tune');
    expect(tune?.devOnly).toBe(true);
    mount(tune!.component);
    expect(await screen.findByRole('radiogroup', { name: '活动方式' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '镜头预设' })).toBeTruthy();
    const curves = screen.getByRole('region', { name: '状态与行为决策' });
    await waitFor(() => expect(within(curves).getByRole('img', { name: /^精神和心情 24 小时/ })).toBeTruthy());
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await waitFor(() => expect(grid.querySelector('[data-motion="nod"]')?.textContent).toContain('批准之后'));
  });

  it('/tune lists hair and cloth physics among the capability chips', async () => {
    mount(findRoute('/tune')!.component);
    expect((await screen.findByRole('switch', { name: '头发衣物物理' })).getAttribute('aria-checked')).toBe('true');
  });

  it('shows her energy and mood codes as their Chinese words', () => {
    const state = { ...STATE_WITH_CAUSES, labels: { energy: 'very_sleepy', mood: 'good', engagement: 'some' } };
    render(<TuneBehavior n={{ rows: {}, saved: {}, statuses: {} }} set={() => {}} pending={new Set()} offline={false} actions={[]} state={state} scales={null} map={false} />);
    expect(screen.getByText('很困')).toBeTruthy();
    expect(screen.getByText('不错')).toBeTruthy();
    expect(screen.queryByText(/very_sleepy|good/)).toBeNull();
  });

  it('#/character?tab=render stays on /character', async () => {
    const router = createAppRouter();
    router.history.push('/character?tab=render&still=1');
    await router.load();
    expect(router.state.location.pathname).toBe('/character');
    expect(router.state.location.search).toMatchObject({ tab: 'render', still: 1 });
  });
});

describe(' 调参 落地与环境', () => {
  const GROUND = ['rnd.ground', 'rnd.ambient', 'rnd.wrap'];
  function install() {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    return bridge;
  }
  const plate = () => screen.findByRole('region', { name: '落地与环境' });

  it('draws 脚下阴影, 环境取色 and 边缘环境光 in the plate', async () => {
    install();
    mount(findRoute('/tune')!.component);
    const p = await plate();
    expect(within(within(p).getByRole('radiogroup', { name: '脚下阴影' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['关', '接触阴影']);
    expect(within(within(p).getByRole('radiogroup', { name: '环境取色' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['关', '壁纸颜色', '屏幕取色']);
    expect(within(p).getByRole('switch', { name: '边缘环境光' }).getAttribute('aria-checked')).toBe('false');
  });

  it('saves 脚下阴影 关 and the 边缘环境光 switch through settings.save', async () => {
    const bridge = install();
    const save = vi.spyOn(bridge.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: [] });
    mount(findRoute('/tune')!.component);
    const p = await plate();
    fireEvent.click(within(within(p).getByRole('radiogroup', { name: '脚下阴影' })).getByRole('radio', { name: '关' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ 'rnd.ground': 'off' }));
    fireEvent.click(within(p).getByRole('switch', { name: '边缘环境光' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ 'rnd.wrap': true }));
  });

  it('draws none of the three when the schema lacks them', async () => {
    const bridge = install();
    vi.spyOn(bridge.settings, 'schema').mockResolvedValue(DEMO_SCHEMA.filter((r) => !GROUND.includes(r.id)));
    mount(findRoute('/tune')!.component);
    await screen.findByRole('radiogroup', { name: '镜头预设' });
    expect(screen.queryByRole('region', { name: '落地与环境' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '脚下阴影' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '环境取色' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '边缘环境光' })).toBeNull();
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
