// 角色页的页签：外观 / 动作 / 设定 各自一条页签条（外观 外观·显示·模组设置·导入，动作 动作表·编排·导入）；选中的页记在 URL 的 `?pane=`；舞台在面板外，不随面板滚动。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

async function mount(search = '&pane=motion') {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('tablist', { name: '角色页签' });
  await screen.findByRole('tabpanel');
  return router;
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const tab = (name: string) => within(screen.getByRole('tablist', { name: '角色页签' })).getByRole('tab', { name });
const tabs = () => within(screen.getByRole('tablist', { name: '角色页签' })).getAllByRole('tab').map((t) => t.textContent);
const panel = () => screen.getByRole('tabpanel');
const pane = (router: Awaited<ReturnType<typeof mount>>) => new URLSearchParams(router.state.location.searchStr).get('pane');

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('角色页 · 页签', () => {
  it('?pane=motion opens 动作表: the motion table and no 编排, appearance or import controls', async () => {
    await mount();
    expect(tabs()).toEqual(['动作表', '编排', '导入']);
    expect(tab('动作表').getAttribute('aria-selected')).toBe('true');
    expect(panel().getAttribute('aria-label')).toBe('动作表');
    expect(await within(panel()).findByRole('grid', { name: '全部动作' })).toBeTruthy();
    expect(within(panel()).queryByRole('region', { name: '编排' })).toBeNull();
    expect(screen.queryByRole('listbox', { name: '外观' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导入动作' })).toBeNull();
  });

  it('puts the chains on their own 编排 tab', async () => {
    const router = await mount();
    await click(tab('编排'));
    await waitFor(() => expect(pane(router)).toBe('chain'));
    expect(tab('编排').getAttribute('aria-selected')).toBe('true');
    expect(panel().getAttribute('aria-label')).toBe('编排');
    expect(within(panel()).getByRole('region', { name: '编排' })).toBeTruthy();
    expect(screen.queryByRole('grid', { name: '全部动作' })).toBeNull();
  });

  it('switches content under 外观 and writes the pane into the URL', async () => {
    const router = await mount('&pane=look');
    expect(tabs()).toEqual(['外观', '显示', '导入']);
    expect(tab('外观').getAttribute('aria-selected')).toBe('true');
    expect(within(panel()).getByRole('region', { name: '角色外观与大小' })).toBeTruthy();
    expect(within(panel()).getByRole('listbox', { name: '外观' })).toBeTruthy();
    expect(within(panel()).getByRole('slider', { name: '大小' })).toBeTruthy();
    expect(screen.queryByRole('grid', { name: '全部动作' })).toBeNull();

    await click(tab('显示'));
    expect(pane(router)).toBe('look');
    expect(within(panel()).getByRole('listbox', { name: '服装分层' })).toBeTruthy();
    expect(within(panel()).queryByRole('listbox', { name: '外观' })).toBeNull();

    await click(tab('导入'));
    await waitFor(() => expect(pane(router)).toBe('import'));
    // 导入 stays under 外观, the item it was opened from.
    expect(tabs()).toEqual(['外观', '显示', '导入']);
    for (const g of ['角色', '外观与 mod', '动作']) expect(within(panel()).getByRole('region', { name: g })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '导入角色' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '导入动作' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '角色外观与大小' })).toBeNull();

    await click(tab('外观'));
    await waitFor(() => expect(pane(router)).toBe('look'));
    expect(within(panel()).getByRole('listbox', { name: '外观' })).toBeTruthy();
  });

  it('opens the pane the URL names', async () => {
    await mount('&pane=import');
    expect(tab('导入').getAttribute('aria-selected')).toBe('true');
    cleanup();
    await mount('&pane=chain');
    expect(tab('编排').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the stage outside the scrolling panel', async () => {
    await mount();
    const stage = document.querySelector('[data-character-preview] [data-preview-stage]');
    expect(stage).not.toBeNull();
    expect(panel().contains(stage)).toBe(false);
    expect(document.querySelector('[data-view="operator"]')).not.toBeNull();
  });
});
