// 角色页总览：默认（无参数、`?pane=overview`）是总览；左侧头像条点头像直接请求换人；最右竖栏写 URL 参数；舞台元素仍带 data-preview-stage。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

let bridge: AgenticComplexBridge;

async function mount(search = '') {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: '角色分区' });
  return router;
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const rail = (name: string) => within(screen.getByRole('navigation', { name: '角色分区' })).getByRole('button', { name });
/** The page's own params; a jump adds the shell's `focus`. */
const params = (router: Awaited<ReturnType<typeof mount>>) => Object.fromEntries([...new URLSearchParams(router.state.location.searchStr)].filter(([k]) => ['pane', 'tab', 'view', 'row'].includes(k)));

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('角色页 · 总览', () => {
  it('opens on 总览 without params, for ?pane=overview and for a pane it does not know', async () => {
    for (const search of ['', '&pane=overview', '&pane=nope']) {
      await mount(search);
      expect(rail('总览').getAttribute('aria-current')).toBe('page');
      expect(document.querySelector('[data-view="operator"]')?.getAttribute('data-mode')).toBe('overview');
      expect(screen.queryByRole('tablist', { name: '角色页签' })).toBeNull();
      expect(screen.queryByRole('grid', { name: '全部动作' })).toBeNull();
      cleanup();
    }
  });

  it('keeps the live preview stage element, with no control inside it', async () => {
    await mount();
    const stage = document.querySelector('[data-preview-stage]') as HTMLElement;
    expect(stage).not.toBeNull();
    expect(stage.closest('[data-character-preview]')).not.toBeNull();
    expect(within(stage).queryAllByRole('button')).toEqual([]);
    expect(document.querySelector('[data-stage]')?.textContent).toContain('示例乙');
  });

  it('asks to switch at once when a head in the strip is clicked', async () => {
    const to = vi.spyOn(bridge.character, 'switchTo');
    await mount();
    const heads = screen.getByRole('group', { name: '角色头像' });
    expect(within(heads).getByRole('button', { name: '示例乙' }).getAttribute('aria-current')).toBe('true');
    await click(within(heads).getByRole('button', { name: '示例甲' }));
    // useSwitch asks first; confirming calls the shell.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('示例甲');
    expect(to).not.toHaveBeenCalled();
  });

  it('writes each rail item into the URL', async () => {
    const router = await mount();
    const steps: Array<[string, Record<string, string>]> = [
      ['外观', { pane: 'look' }],
      ['动作', { pane: 'motion' }],
      ['设定', { tab: 'behavior' }],
      ['拍照', { view: 'photo' }],
      ['总览', {}],
    ];
    for (const [name, want] of steps) {
      await click(rail(name));
      await waitFor(() => expect(params(router)).toEqual(want));
      expect(rail(name).getAttribute('aria-current')).toBe('page');
    }
  });

  it('moves the stage beside the panel on a detail page and to 拍照 with the panel alone', async () => {
    const router = await mount('&tab=render');
    const op = document.querySelector('[data-view="operator"]') as HTMLElement;
    expect(op.getAttribute('data-mode')).toBe('detail');
    const bar = screen.getByRole('tablist', { name: '角色页签' });
    expect(within(bar).getAllByRole('tab').map((t) => t.textContent)).toEqual(['行为', '画面', '场景']);
    expect(document.querySelector('[data-stage]')?.getAttribute('data-mode')).toBe('detail');
    await click(within(bar).getByRole('tab', { name: '场景' }));
    await waitFor(() => expect(params(router)).toEqual({ tab: 'scene' }));
    cleanup();
    await mount('&view=photo');
    expect(document.querySelector('[data-stage]')?.getAttribute('data-mode')).toBe('photo');
    expect(screen.queryByRole('group', { name: '角色头像' })).toBeNull();
  });
});
