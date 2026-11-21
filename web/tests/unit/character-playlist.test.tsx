// The MMD view's MMD list (character.getPlaylist/setPlaylist, avatar.playPlaylist/playlistState) and the speed lock read from AvatarAction.media.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarAction } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
// The 动作 pane draws the chain graph.
vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

let bridge: AgenticComplexBridge;

const MMD: AvatarAction[] = [
  { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 12, playable: true, media: { bgm: true, face: true, camera: false } },
  { id: 'mmd_b', label: '舞蹈乙', enabled: true, section: 'idle', durationS: 9, playable: true },
];

function install(extra: AvatarAction[]) {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  const real = bridge.avatar.actions.bind(bridge.avatar);
  vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), ...extra.map((a) => ({ ...a }))]);
}

/** The MMD view by default; the 动作 tab with `''`. */
async function mount(search = '&view=mmd') {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-page]')).not.toBeNull());
  await screen.findByRole('button', { name: /^切换角色/ });
  await act(async () => {});
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const row = (id: string) => document.querySelector(`[data-playlist-row="${id}"]`) as HTMLElement;
const list = () => screen.findByRole('region', { name: 'MMD 列表' });

beforeEach(() => install(MMD));
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('MMD list', () => {
  it('is not drawn when the character has no MMD action', async () => {
    install([]);
    await mount();
    expect(screen.queryByRole('region', { name: 'MMD 列表' })).toBeNull();
    expect(document.querySelector('[data-playlist-row]')).toBeNull();
  });

  it('lists the mmd_ actions numbered in her order and saves adds, moves and the loop mode', async () => {
    const set = vi.spyOn(bridge.character, 'setPlaylist');
    await mount();
    await list();
    expect(row('mmd_a').textContent).toContain('01');
    expect(row('mmd_b').textContent).toContain('02');
    expect(row('mmd_a').textContent).toContain('舞蹈甲');
    await click(within(row('mmd_a')).getByRole('button', { name: '加入' }));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_a'], loop: 'off', speed: 1 });
    await click(within(row('mmd_b')).getByRole('button', { name: '加入' }));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 1 });
    await click(within(row('mmd_b')).getByRole('button', { name: '上移' }));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_b', 'mmd_a'], loop: 'off', speed: 1 });
    await click(within(screen.getByRole('radiogroup', { name: '循环' })).getByRole('radio', { name: '全部' }));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_b', 'mmd_a'], loop: 'all', speed: 1 });
    await click(within(screen.getByRole('radiogroup', { name: '连播速度' })).getByRole('radio', { name: '2×' }));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_b', 'mmd_a'], loop: 'all', speed: 2 });
    await click(within(row('mmd_a')).getByRole('button', { name: '移出' }));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_b'], loop: 'all', speed: 2 });
  });

  it('plays and stops the list and marks the row playing now', async () => {
    await bridge.character.setPlaylist({ items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 1 });
    const play = vi.spyOn(bridge.avatar, 'playPlaylist').mockResolvedValue({ ok: true });
    const stop = vi.spyOn(bridge.avatar, 'stopPlaylist');
    vi.spyOn(bridge.avatar, 'playlistState').mockResolvedValue({ playing: true, index: 1, id: 'mmd_b' });
    await mount();
    await list();
    await waitFor(() => expect(row('mmd_b').getAttribute('aria-current')).toBe('true'));
    expect(row('mmd_a').getAttribute('aria-current')).toBeNull();
    await click(within(await list()).getByRole('button', { name: '播放' }));
    expect(play).toHaveBeenCalled();
    await click(within(await list()).getByRole('button', { name: '停止' }));
    expect(stop).toHaveBeenCalled();
  });
});

describe('speed lock reads media', () => {
  const speeds = () => within(screen.getByRole('radiogroup', { name: '播放速度' })).getAllByRole('radio') as HTMLButtonElement[];

  it('a BGM action with media plays at 2×; one without media that the import list says has BGM stays at 1×', async () => {
    // Not `mmd_` ids: the 动作 table leaves the shared MMD dances out.
    install([{ ...MMD[0]!, id: 'dance_a' }, { id: 'vmd_old', label: '旧舞蹈', enabled: true, section: 'idle', durationS: 8, playable: true }]);
    vi.spyOn(bridge.character, 'listImportedMotions').mockResolvedValue({
      ok: true,
      motions: [{ id: 'vmd_old', clip: 'imported_vmd_old', title: '旧舞蹈', format: 'vmd', durationS: 8, hasBgm: true, createdAt: null, warnings: [] }],
    });
    await mount('');
    await screen.findAllByText('点头附和');
    const mmd = document.querySelector('[data-motion="dance_a"]')!;
    expect(mmd.textContent).toContain('BGM');
    expect(mmd.textContent).toContain('表情');
    expect(mmd.textContent).not.toContain('相机');
    await click(mmd);
    expect(speeds().find((r) => r.textContent === '2×')!.disabled).toBe(false);
    await click(document.querySelector('[data-motion="vmd_old"]')!);
    await waitFor(() => expect(speeds().every((r) => r.disabled)).toBe(true));
    expect(speeds().find((r) => r.textContent === '1×')!.getAttribute('aria-checked')).toBe('true');
  });
});
