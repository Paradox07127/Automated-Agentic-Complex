// 角色页 and MMD: the rail's MMD item and `?view=mmd` open the MMD section beside the rail on the one stage, `/mmd` lands there;
// the 动作 tab and the 导入 pane leave its dances out.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarAction, AgenticComplexBridge } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';
import { createAppRouter } from '../../src/shell/router';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

const MMD_ACTION: AvatarAction = { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 12, playable: true };

function install() {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
}

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
const tab = (name: string) => within(screen.getByRole('navigation', { name: '角色分区' })).getByRole('button', { name });

beforeEach(install);
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('MMD is a section of 角色', () => {
  const library = () => screen.queryByRole('region', { name: 'MMD 库' });
  const current = () => screen.getByRole('navigation', { name: '角色分区' }).querySelector('[aria-current="page"]');

  it('the MMD rail item after 拍照 opens ?view=mmd with the rail still there, keeping the view flags', async () => {
    // The shell's hash, which a jump reads the view flags from.
    window.location.hash = '#/character?still=1&theme=light';
    const router = await mount('&theme=light');
    const btn = tab('MMD');
    expect(btn.previousElementSibling?.textContent).toBe('拍照');
    await click(btn);
    expect(router.state.location.pathname).toBe('/character');
    const q = new URLSearchParams(router.state.location.searchStr);
    expect(q.get('view')).toBe('mmd');
    expect(q.get('theme')).toBe('light');
    expect(await screen.findByRole('region', { name: 'MMD 库' })).toBeTruthy();
    expect(current()?.textContent).toContain('MMD');
  });

  it('总览 and 动作 on the rail leave the MMD section', async () => {
    const router = await mount('&view=mmd');
    expect(await screen.findByRole('region', { name: 'MMD 库' })).toBeTruthy();
    await click(tab('总览'));
    await waitFor(() => expect(library()).toBeNull());
    expect(new URLSearchParams(router.state.location.searchStr).get('view')).toBeNull();
    await click(tab('MMD'));
    await screen.findByRole('region', { name: 'MMD 库' });
    await click(tab('动作'));
    await waitFor(() => expect(library()).toBeNull());
    expect(new URLSearchParams(router.state.location.searchStr).get('pane')).toBe('motion');
  });

  it('keeps one stage: the same node on 总览, MMD and 动作', async () => {
    await mount();
    const stage = document.querySelector('[data-preview-stage]');
    expect(stage).not.toBeNull();
    await click(tab('MMD'));
    await screen.findByRole('region', { name: 'MMD 库' });
    expect(document.querySelectorAll('[data-preview-stage]').length).toBe(1);
    expect(document.querySelector('[data-preview-stage]')).toBe(stage);
    await click(tab('动作'));
    await waitFor(() => expect(library()).toBeNull());
    expect(document.querySelector('[data-preview-stage]')).toBe(stage);
  });
});

describe('/mmd', () => {
  it('redirects (replace) to /character?view=mmd with theme and still kept', async () => {
    window.location.hash = '#/mmd?theme=light&still=1&x=2';
    const entries = window.history.length;
    const router = createAppRouter();
    await act(async () => void (await router.load()));
    expect(router.state.location.pathname).toBe('/character');
    const q = new URLSearchParams(router.state.location.searchStr);
    expect(q.get('view')).toBe('mmd');
    expect(q.get('theme')).toBe('light');
    expect(q.get('still')).toBe('1');
    expect(q.get('x')).toBeNull();
    expect(window.history.length).toBe(entries);
  });
});

describe('motion tabs without MMD dances', () => {
  it('the 动作 table and its tab leave out mmd_ rows and the MMD 列表', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { ...MMD_ACTION }]);
    await mount('&pane=motion');
    await screen.findAllByText('点头附和');
    expect(document.querySelector('[data-motion="nod"]')).not.toBeNull();
    expect(document.querySelector('[data-motion="mmd_a"]')).toBeNull();
    expect(screen.queryByRole('region', { name: 'MMD 列表' })).toBeNull();
  });

  it('the 导入 pane lists imported motions but not VMD ones', async () => {
    vi.spyOn(bridge.character, 'listImportedMotions').mockResolvedValue({
      ok: true,
      motions: [
        { id: 'mmd_old', clip: 'imported_mmd_old', title: '旧舞蹈', format: 'vmd', durationS: 8, hasBgm: true, createdAt: null, warnings: [] },
        { id: 'bvh_walk', clip: 'imported_bvh_walk', title: 'walk', format: 'bvh', durationS: 3, hasBgm: false, createdAt: null, warnings: [] },
      ],
    });
    await mount('&pane=motion');
    await click(await screen.findByRole('tab', { name: '导入' }));
    const list = await screen.findByRole('list', { name: '导入的动作' });
    expect(Array.from(list.querySelectorAll('[data-imported-motion]')).map((e) => e.getAttribute('data-imported-motion'))).toEqual(['bvh_walk']);
  });
});
