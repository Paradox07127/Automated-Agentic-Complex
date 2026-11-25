// Character page: switcher row; stage │ motion switches; commit line in the bottom bar; demos and mock-only blocks.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { RuntimeSnapshot } from '../../src/bridge/runtimeSnapshot';
import { MOTIONS } from '../../src/mock/character';
import { Operator } from '../../src/pages/character/Operator';
import { CharacterPage } from '../../src/pages/character/Page';
import { demos } from '../../src/pages/character/demos';
import { HeaderSlotContext } from '../../src/shell/headerSlot';
import { toast as pushToast } from '../../src/shell/toast';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

async function mount(search = '', component: RouteComponent = CharacterPage) {
  window.location.hash = `#/character?still=1${search}`;
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-page]')).not.toBeNull());
  return router;
}

const stage = () => document.querySelector('[data-stage]') as HTMLElement;

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

describe('character · 角色与动作', () => {
  it('draws the roster, the stage and the whole motion table', async () => {
    await mount('&demo=ok');
    // The full roster, with 导入角色 at its end, opens from the 切换角色 key of 总览's head strip.
    expect(screen.queryByRole('navigation', { name: '角色名册' })).toBeNull();
    const toggle = await screen.findByRole('button', { name: '切换角色，当前 示例乙' });
    await act(async () => void fireEvent.click(toggle));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const roster = screen.getByRole('navigation', { name: '角色名册' });
    const items = within(roster).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['01示例乙', '02示例甲', '03示例丙', '导入角色']);
    expect(items.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null, null]);
    expect(items[1]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('02');
    cleanup();
    // The detail pages have no head strip and no roster key.
    await mount('&demo=ok&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    // The selected motion is its row alone: the stage has no 当前动作 band repeating it.
    await waitFor(() => expect(grid.querySelector('[data-motion="nod"]')?.getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByRole('button', { name: /^切换角色/ })).toBeNull();
    expect(grid.querySelector('[data-motion="nod"]')?.textContent).toContain('批准之后');
    expect(stage().textContent).not.toContain('批准之后');
    expect(['说话', '反应', '待机', '移动与姿态', '互动'].every((s) => grid.textContent?.includes(s))).toBe(true);
    const walk = grid.querySelector<HTMLElement>('[data-motion="walk"]')!;
    expect(walk.querySelector('[data-mark="auto"]')).not.toBeNull();
    expect(walk.title).toBe('由行为触发 │ 不支持单独预览');
    expect(grid.textContent).not.toContain('不支持单独预览');
    expect(grid.querySelector('[data-motion="idle"]')?.textContent).toContain('—');
    expect(grid.querySelector('[data-motion="whisper"]')?.textContent).toContain('新');
    expect(screen.getByText(/已修改/).textContent).toContain('2');
  });

  it('selects a motion from the table and says why a missing one cannot preview', async () => {
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await act(async () => void fireEvent.click(grid.querySelector('[data-motion="think"] button')!));
    expect(grid.querySelector('[data-motion="think"]')?.getAttribute('aria-selected')).toBe('true');
    // The slot under the stage says why 桌面预览 is off.
    expect(within(stage()).getByRole('status').textContent).toContain('缺少 think_02 │ 不支持预览');
    expect((screen.getByRole('button', { name: /桌面预览/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => void fireEvent.click(grid.querySelector('[data-motion="walk"] button')!));
    expect(within(stage()).getByRole('status').textContent).toContain('由行为触发 │ 不支持单独预览');
  });

  it('lands on the motion a link names in `row`, selected and scrolled to', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await mount('&pane=motion&row=whisper');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await waitFor(() => expect(grid.querySelector('[data-motion="whisper"]')?.getAttribute('aria-selected')).toBe('true'));
    expect(grid.querySelector('[data-motion="nod"]')?.getAttribute('aria-selected')).toBe('false');
    expect(scroll.mock.contexts).toContain(grid.querySelector('[data-motion="whisper"]'));
  });

  it('follows a new `row` while the motion table stays open', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const router = await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await waitFor(() => expect(grid.querySelector('[data-motion="nod"]')?.getAttribute('aria-selected')).toBe('true'));
    await act(async () => void (await router.navigate({ to: '/', search: { still: '1', pane: 'motion', row: 'whisper' } })));
    await waitFor(() => expect(grid.querySelector('[data-motion="whisper"]')?.getAttribute('aria-selected')).toBe('true'));
  });

  it('plays on the desktop and shows the progress on the stage', async () => {
    await mount('&pane=motion');
    await screen.findByRole('grid', { name: '全部动作' });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /桌面预览/ })));
    await waitFor(() => expect(within(stage()).getByRole('status').textContent).toContain('点头附和'));
  });

  it('filters to missing motions and searches across sections', async () => {
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    fireEvent.click(screen.getByRole('button', { name: /仅显示缺少资源/ }));
    expect([...grid.querySelectorAll('[data-motion]')].map((r) => r.getAttribute('data-motion'))).toEqual(['think', 'lean']);
    fireEvent.click(screen.getByRole('button', { name: /仅显示缺少资源/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索动作' }), { target: { value: '窗' } });
    expect([...grid.querySelectorAll('[data-motion]')].map((r) => r.getAttribute('data-motion'))).toEqual(['sit', 'lean']);
  });

  it('has no plays-today display on 动作, even on the mock bridge that counts them for 调参', async () => {
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await waitFor(() => expect(document.querySelector('[data-motion="nod"]')?.getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('今日播放')).toBeNull();
    expect(screen.queryByRole('img', { name: /今日按小时播放/ })).toBeNull();
    expect(document.querySelector('[data-motions]')?.textContent).not.toContain('今日');
    expect(grid.querySelector('[title="今日播放次数"]')).toBeNull();
    expect(stage().textContent).not.toContain('今日');
    expect(stage().textContent).not.toContain('次');
  });

  it('error: says the state read failed and keeps the motion table', async () => {
    await mount('&state=error&pane=motion');
    expect(await screen.findByText(/读取角色状态失败/)).toBeTruthy();
  });
});

describe('角色 page layout', () => {
  it('puts the name block with what she is doing on 总览 only, apart from the selected motion on 动作', async () => {
    await mount();
    await waitFor(() => expect(stage().querySelector('[data-nameplate]')?.textContent).toContain('当前状态坐姿待机'));
    expect(stage().querySelector('[data-nameplate]')?.textContent).toContain('示例乙');
    cleanup();
    await mount('&pane=motion');
    await waitFor(() => expect(document.querySelector('[data-motion="nod"]')?.getAttribute('aria-selected')).toBe('true'));
    expect(stage().querySelector('[data-nameplate]')).toBeNull();
    expect(stage().textContent).not.toContain('坐着');
  });

  it('section tabs mark the selected motion’s section and move to the one jumped to', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    const tabs = screen.getByRole('group', { name: '跳转到分区' });
    const current = () => within(tabs).getAllByRole('button').filter((b) => b.hasAttribute('aria-current')).map((b) => b.textContent);
    expect(current()).toEqual(['对话']);
    fireEvent.click(within(tabs).getByRole('button', { name: '跳转到 互动' }));
    expect(current()).toEqual(['互动']);
    await act(async () => void fireEvent.click(grid.querySelector('[data-motion="click"] button')!));
    expect(current()).toEqual(['反应']);
  });

  it('draws the draft state, 桌面预览 and 保存 in its own action bar and leaves the shell’s bottom bar empty', async () => {
    const bottom = document.createElement('div');
    document.body.append(bottom);
    const slot = { setSub: () => {}, right: null, action: null, bottom };
    const ui = render(
      <HeaderSlotContext.Provider value={slot}>
        <Operator
          roster={[{ id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: [] }]}
          current="si"
          sw={{ state: { phase: 'idle' }, request: () => {}, retry: () => {}, dismiss: () => {} }}
          offline={false}
          backoff={null}
          onRestart={() => {}}
          actions={MOTIONS}
          motionsError={null}
          onRetryMotions={() => {}}
          charState={null}
          seed={{ stretch: false }}
          toast={() => {}}
        />
      </HeaderSlotContext.Provider>,
    );
    const view = ui.container.querySelector('[data-view="operator"]') as HTMLElement;
    const bar = view.querySelector('[data-commit]') as HTMLElement;
    expect(within(bar).getByText(/已修改/).textContent).toContain('1');
    expect(bar.textContent).toContain('伸懒腰 开→关');
    expect(within(bar).getByRole('button', { name: /桌面预览/ })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '保存' })).toBeTruthy();
    expect(bottom.childElementCount).toBe(0);
    ui.unmount();
    bottom.remove();
  });
});

describe('character · real data', () => {
  it('leaves out the blocks agentd and the host do not serve yet', async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    await mount('&pane=motion');
    await waitFor(() => expect(document.querySelector('[data-motion="nod"]')?.getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('今日播放')).toBeNull();
    expect(stage().textContent).not.toContain('今日');
    expect(screen.queryByRole('switch', { name: '显示武器' })).toBeNull();
  });

  it("draws the current character's package background as the room's watermark, and none without one", async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const background = 'agentic-complex-ui://app/characters/si/background.png';
    vi.spyOn(bridge.character, 'list').mockResolvedValue([{ id: 'si', name: '示例乙', en: 'SI', active: true, voice: false, appearances: [], background }]);
    window.agenticComplex = bridge;
    await mount();
    const watermark = () => document.querySelector('[data-training-room] img');
    await waitFor(() => expect(watermark()?.getAttribute('src')).toBe(background));
    cleanup();
    vi.spyOn(bridge.character, 'list').mockResolvedValue([{ id: 'si', name: '示例乙', en: 'SI', active: true, voice: false, appearances: [] }]);
    await mount();
    await screen.findByText('示例乙');
    expect(watermark()).toBeNull();
  });
});

describe('character · availability and refetches', () => {
  /** Pushes runtime snapshots the test writes. */
  const pushes = (bridge: ReturnType<typeof createFakeBridge>) => {
    let push: (s: RuntimeSnapshot) => void = () => {};
    vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    return async (avatar: Partial<RuntimeSnapshot['processes']['avatar']>) => {
      const s = await bridge.app.runtime();
      await act(async () => push({ ...s, processes: { ...s.processes, avatar: { ...s.processes.avatar, ...avatar } } }));
    };
  };

  it('follows the avatar process from the runtime pushes: stopped is offline, running again is back', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    const push = pushes(bridge);
    await mount();
    await screen.findByText('示例乙');
    expect(screen.queryByText('角色未运行')).toBeNull();
    await push({ state: 'backoff', backoff: 8 });
    expect((await screen.findByText('角色进程未运行')).closest('[role="status"]')?.textContent).toContain('将在 8 秒后重试');
    await push({ state: 'running', backoff: null });
    await waitFor(() => expect(screen.queryByText('角色未运行')).toBeNull());
  });

  it('keeps the operator and its unsaved switches when a roster reread fails, and says so', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    await mount('&demo=ok&pane=motion');
    await waitFor(() => expect(screen.getByText(/已修改/).textContent).toContain('2'));
    vi.spyOn(bridge.character, 'list').mockRejectedValue({ code: 'failed', detail: 'catalog' });
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: '更多' })));
    await act(async () => void fireEvent.click(screen.getByRole('menuitem', { name: '重新读取角色目录' })));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('读取角色列表失败'));
    expect(screen.getByRole('grid', { name: '全部动作' })).toBeTruthy();
    expect(screen.getByText(/已修改/).textContent).toContain('2');
  });

  it('says so when the restart is refused instead of announcing it', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    const push = pushes(bridge);
    vi.spyOn(bridge.supervisor, 'restart').mockRejectedValue({ code: 'failed', detail: 'no supervisor' });
    vi.mocked(pushToast).mockClear();
    await mount();
    await screen.findByText('示例乙');
    await push({ state: 'stopped' });
    await act(async () => void fireEvent.click(await screen.findByRole('button', { name: '重启角色进程' })));
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('未能重启角色进程：角色渲染进程无响应', { severity: 'danger' }));
    expect(pushToast).not.toHaveBeenCalledWith('正在重启角色进程…');
  });

  it('shows the overview activity only of the character it shows', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = bridge;
    // agentd still reports si's state while the host is on voice_a.
    await bridge.character.switchTo('voice_a');
    await mount();
    await screen.findAllByText('示例甲');
    expect(document.querySelector('[data-stage]')?.textContent).not.toContain('坐着');
  });
});

describe('character · demos', () => {
  it('lists default, light, loading, error and the prototype demos', () => {
    const names = demos.map((d) => d.name);
    for (const n of ['default', 'ok', 'light', 'loading', 'error', 'offline', 'switching']) expect(names).toContain(n);
    expect(names).not.toContain('full');
    expect(names).not.toContain('sparse');
  });
});
