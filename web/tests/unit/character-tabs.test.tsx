// 角色页右栏的 动作 / 编排 / 外观 / 导入 页签：切换内容，选中的页签记在 URL 的 `?pane=`；预览台在页签外，不随右栏滚动。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

async function mount(search = '') {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('tablist', { name: '角色页签' });
  // The tabs are up while the catalog loads; the panes come after it.
  await screen.findByRole('tabpanel');
  return router;
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const tab = (name: string) => within(screen.getByRole('tablist', { name: '角色页签' })).getByRole('tab', { name });
const panel = () => screen.getByRole('tabpanel');

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('角色页 · 页签', () => {
  it('opens on 动作: the motion table and no 编排, appearance or import controls', async () => {
    await mount();
    expect(tab('动作').getAttribute('aria-selected')).toBe('true');
    expect(panel().getAttribute('aria-label')).toBe('动作');
    expect(await within(panel()).findByRole('grid', { name: '全部动作' })).toBeTruthy();
    expect(within(panel()).queryByRole('region', { name: '编排' })).toBeNull();
    expect(screen.queryByRole('listbox', { name: '外观' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导入动作' })).toBeNull();
  });

  it('puts the chains on their own 编排 pane', async () => {
    const router = await mount();
    await click(tab('编排'));
    await waitFor(() => expect(new URLSearchParams(router.state.location.searchStr).get('pane')).toBe('chain'));
    expect(tab('编排').getAttribute('aria-selected')).toBe('true');
    expect(panel().getAttribute('aria-label')).toBe('编排');
    expect(within(panel()).getByRole('region', { name: '编排' })).toBeTruthy();
    expect(screen.queryByRole('grid', { name: '全部动作' })).toBeNull();
  });

  it('switches content and writes the pane into the URL', async () => {
    const router = await mount();
    await click(tab('外观'));
    await waitFor(() => expect(new URLSearchParams(router.state.location.searchStr).get('pane')).toBe('look'));
    expect(tab('外观').getAttribute('aria-selected')).toBe('true');
    expect(within(panel()).getByRole('region', { name: '角色外观与大小' })).toBeTruthy();
    expect(within(panel()).getByRole('listbox', { name: '外观' })).toBeTruthy();
    expect(screen.queryByRole('grid', { name: '全部动作' })).toBeNull();

    await click(tab('导入'));
    await waitFor(() => expect(new URLSearchParams(router.state.location.searchStr).get('pane')).toBe('import'));
    for (const g of ['角色', '外观与 mod', '动作']) expect(within(panel()).getByRole('region', { name: g })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '导入角色' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '导入动作' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '角色外观与大小' })).toBeNull();

    await click(tab('动作'));
    await waitFor(() => expect(new URLSearchParams(router.state.location.searchStr).get('pane')).toBe('motion'));
    expect(await within(panel()).findByRole('grid', { name: '全部动作' })).toBeTruthy();
  });

  it('opens the pane the URL names, and 动作 for one it does not know', async () => {
    await mount('&pane=import');
    expect(tab('导入').getAttribute('aria-selected')).toBe('true');
    cleanup();
    await mount('&pane=nope');
    expect(tab('动作').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the stage and 今日播放 out of the scrolling pane', async () => {
    await mount();
    const stage = document.querySelector('[data-character-preview] [data-preview-stage]');
    expect(stage).not.toBeNull();
    expect(panel().contains(stage)).toBe(false);
    expect(document.querySelector('[data-view="operator"]')).not.toBeNull();
  });
});
