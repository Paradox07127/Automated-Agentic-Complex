// Character page: switcher row; stage │ motion switches; commit line in the bottom bar; 行为与画面 and the state tabs on 调参; demos and mock-only blocks.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { MOTIONS } from '../../src/mock/character';
import { Operator } from '../../src/pages/character/Operator';
import { CharacterPage } from '../../src/pages/character/Page';
import { demos } from '../../src/pages/character/demos';
import { TunePage } from '../../src/pages/tune/Page';
import { HeaderSlotContext } from '../../src/shell/headerSlot';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
// The 动作 pane draws the chain graph.
vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

async function mount(search = '', component: RouteComponent = CharacterPage) {
  window.location.hash = `#/${component === TunePage ? 'tune' : 'character'}?still=1${search}`;
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-page]')).not.toBeNull());
}

const stage = () => document.querySelector('[data-stage]') as HTMLElement;

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

describe('character · 角色与动作', () => {
  it('draws the roster, the stage and the whole motion table', async () => {
    await mount('&demo=ok&pane=motion');
    // The full roster, with 导入 at its end, opens from the head strip's 切换角色 key.
    expect(screen.queryByRole('navigation', { name: '角色名册' })).toBeNull();
    const toggle = await screen.findByRole('button', { name: '切换角色，当前 示例乙' });
    await act(async () => void fireEvent.click(toggle));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const roster = screen.getByRole('navigation', { name: '角色名册' });
    const items = within(roster).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['01示例乙', '02示例甲', '03示例丙', '导入']);
    expect(items.map((b) => b.getAttribute('aria-current'))).toEqual(['true', null, null, null]);
    expect(items[1]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('02');
    await waitFor(() => expect(stage().textContent).toContain('点头附和'));
    expect(stage().textContent).toContain('批准之后');
    const grid = screen.getByRole('grid', { name: '全部动作' });
    expect(['说话', '反应', '待机', '移动与姿态', '互动'].every((s) => grid.textContent?.includes(s))).toBe(true);
    expect(within(grid.querySelector<HTMLElement>('[data-motion="walk"]')!).getByRole('img', { name: '由行为触发 │ 不支持单独预览' })).toBeTruthy();
    expect(grid.textContent).not.toContain('不支持单独预览');
    expect(grid.querySelector('[data-motion="idle"]')?.textContent).toContain('—');
    expect(grid.querySelector('[data-motion="whisper"]')?.textContent).toContain('新');
    expect(screen.getByText(/已修改/).textContent).toContain('2');
  });

  it('selects a motion from the table and says why a missing one cannot preview', async () => {
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await act(async () => void fireEvent.click(grid.querySelector('[data-motion="think"]')!));
    expect(stage().textContent).toContain('思考');
    expect(screen.getAllByText('缺少 think_02 │ 不支持预览').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /桌面预览/ }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => void fireEvent.click(grid.querySelector('[data-motion="walk"]')!));
    expect(screen.getAllByText('由行为触发 │ 不支持单独预览').length).toBeGreaterThan(1);
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
    fireEvent.click(screen.getByRole('button', { name: /仅显示缺资源/ }));
    expect([...grid.querySelectorAll('[data-motion]')].map((r) => r.getAttribute('data-motion'))).toEqual(['think', 'lean']);
    fireEvent.click(screen.getByRole('button', { name: /仅显示缺资源/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索动作' }), { target: { value: '窗' } });
    expect([...grid.querySelectorAll('[data-motion]')].map((r) => r.getAttribute('data-motion'))).toEqual(['sit', 'lean']);
  });

  it('opens 行为决策 on 调参 from the URL and lays out three lanes by who decided', async () => {
    await mount('&ptab=beat', TunePage);
    const tab = await screen.findByRole('tab', { name: '行为决策' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    await waitFor(() => expect(panel.textContent).toContain('规则 1'));
    expect(panel.textContent).toContain('模型 0');
    expect(panel.textContent).toContain('硬规则 0');
  });

  it('has no plays-today display on 动作, even on the mock bridge that counts them for 调参', async () => {
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    await waitFor(() => expect(stage().textContent).toContain('点头附和'));
    expect(screen.queryByText('今日播放')).toBeNull();
    expect(screen.queryByRole('img', { name: /今日按小时播放/ })).toBeNull();
    expect(document.querySelector('[data-motions]')?.textContent).not.toContain('今日');
    expect(grid.querySelector('[title="今日播放次数"]')).toBeNull();
    expect(stage().textContent).not.toContain('今日');
    expect(stage().textContent).not.toContain('次');
  });

  it('sparse: on 调参 a curve from where the log starts', async () => {
    await mount('&demo=sparse', TunePage);
    await waitFor(() => expect(screen.getByText(/起记录/)).toBeTruthy());
  });

  it('error: says the state read failed and keeps the motion table', async () => {
    await mount('&state=error&pane=motion');
    expect(await screen.findByText(/读取角色状态失败/)).toBeTruthy();
  });
});

describe('角色 page layout', () => {
  it('keeps the name and posture separate from the selected motion', async () => {
    await mount('&pane=motion');
    await waitFor(() => expect(stage().textContent).toContain('点头附和'));
    const plate = stage().querySelector('[data-nameplate]')?.textContent ?? '';
    expect(plate).toContain('示例乙');
    expect(plate).toContain('在做坐着');
    expect(plate).not.toContain('点头附和');
  });

  it('section tabs mark the selected motion’s section and move to the one jumped to', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    await mount('&pane=motion');
    const grid = await screen.findByRole('grid', { name: '全部动作' });
    const tabs = screen.getByRole('group', { name: '跳转到分区' });
    const current = () => within(tabs).getAllByRole('button').filter((b) => b.hasAttribute('aria-current')).map((b) => b.textContent);
    expect(current()).toEqual(['说话']);
    fireEvent.click(within(tabs).getByRole('button', { name: '跳转到 互动' }));
    expect(current()).toEqual(['互动']);
    await act(async () => void fireEvent.click(grid.querySelector('[data-motion="click"]')!));
    expect(current()).toEqual(['反应']);
  });

  it('puts the draft state, 桌面预览 and 保存 in the shell’s bottom bar, and leaves it empty without the operator view', async () => {
    const bottom = document.createElement('div');
    document.body.append(bottom);
    const slot = { setSub: () => {}, right: null, action: null, bottom };
    const ui = render(
      <HeaderSlotContext.Provider value={slot}>
        <Operator
          roster={[{ id: 'si', name: '示例乙', en: 'SI', active: true, appearances: [] }]}
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
    expect(within(bottom).getByText(/已修改/).textContent).toContain('1');
    expect(within(bottom).getByRole('button', { name: /桌面预览/ })).toBeTruthy();
    expect(within(bottom).getByRole('button', { name: '保存' })).toBeTruthy();
    expect(within(view).queryByRole('button', { name: /桌面预览|保存/ })).toBeNull();
    ui.unmount();
    expect(bottom.childElementCount).toBe(0);
    bottom.remove();
  });
});

describe('调参 · 行为与画面', () => {
  it('draws behavior, screen, capabilities, camera and frame rate', async () => {
    await mount('', TunePage);
    expect(await screen.findByRole('radiogroup', { name: '活动方式' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /屏幕示意/ })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /看向鼠标/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /镜头水平 0°/ })).toBeTruthy();
    expect(screen.getByText('状态倍数')).toBeTruthy();
    expect(screen.getByText('帧率上限')).toBeTruthy();
  });
});

describe('character · real data', () => {
  it('leaves out the blocks agentd and the host do not serve yet', async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    await mount('&pane=motion');
    await waitFor(() => expect(stage().textContent).toContain('点头附和'));
    expect(screen.queryByText('今日播放')).toBeNull();
    expect(stage().textContent).not.toContain('今日');
    expect(screen.queryByRole('switch', { name: '显示武器' })).toBeNull();
    cleanup();
    await mount('', TunePage);
    await screen.findByRole('radiogroup', { name: '活动方式' });
    expect(screen.queryByRole('img', { name: /屏幕示意/ })).toBeNull();
    expect(screen.queryByText('状态倍数')).toBeNull();
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
