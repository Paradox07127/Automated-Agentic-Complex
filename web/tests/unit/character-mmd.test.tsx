// 角色页「MMD」: the MMD library every character shares (mmd.list/import/syncState/onSync), opened from the header like 拍照; the 动作 tab and the 导入 pane leave its dances out.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarAction, AgenticComplexBridge, MmdEntry, MmdSyncState } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
// The 动作 pane draws the chain graph.
vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

let bridge: AgenticComplexBridge;

const MMD_ACTION: AvatarAction = { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 12, playable: true };
const entry = (id: string, title: string, state: 'baked' | 'pending' | 'failed', reason: string | null = null): MmdEntry => ({
  id, title, durationS: 12.5, hasBgm: true, hasCamera: id === 'mmd_a', createdAt: '2026-11-17T10:00:00+00:00',
  characters: [{ id: 'si', state, reason }, { id: 'voice_a', state: 'pending', reason: null }],
});

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
  await screen.findByRole('button', { name: /^切换角色/ });
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const view = () => document.querySelector<HTMLElement>('[data-view="mmd"]');
const tab = (name: string) => within(screen.getByRole('tablist', { name: '角色页签' })).getByRole('tab', { name });
const item = (id: string) => document.querySelector<HTMLElement>(`[data-mmd="${id}"]`);
// The fake import takes a second.
const SLOW = { timeout: 3000 };

beforeEach(install);
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('MMD view route', () => {
  it('opens from the MMD tab next to 拍照 and the 动作 tab leaves it', async () => {
    await mount();
    const btn = tab('MMD');
    expect(btn.previousElementSibling?.getAttribute('title')).toBe('拍照');
    expect(view()).toBeNull();
    await click(btn);
    await waitFor(() => expect(view()).not.toBeNull());
    expect(tab('MMD').getAttribute('aria-selected')).toBe('true');
    await click(tab('动作'));
    await waitFor(() => expect(view()).toBeNull());
    expect(tab('动作').getAttribute('aria-selected')).toBe('true');
  });

  it('?view=mmd puts the view in the right column', async () => {
    await mount('&view=mmd');
    expect(view()?.closest('[data-view="character-settings"]')).not.toBeNull();
    expect(tab('MMD').getAttribute('aria-selected')).toBe('true');
  });
});

describe('MMD view', () => {
  it('imports a dance: the result line, then the entry baked for her with its BGM mark, played on the desktop', async () => {
    const imp = vi.spyOn(bridge.mmd, 'import');
    const play = vi.spyOn(bridge.avatar, 'playAction');
    await mount('&view=mmd');
    await click(await screen.findByRole('button', { name: '导入 MMD' }));
    expect(imp).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '导入中…' }).getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull(), SLOW);
    expect(document.querySelector('[data-motion-import]')?.textContent).toBe('已导入「示例舞蹈」（VMD）');
    const row = item('mmd_dance_1')!;
    expect(row.textContent).toContain('示例舞蹈');
    expect(row.textContent).toContain('12.5 s');
    expect(within(row).getByText('BGM')).toBeTruthy();
    expect(within(row).queryByText('相机')).toBeNull();
    await click(within(row).getByRole('button', { name: '播放' }));
    expect(play).toHaveBeenCalledWith('mmd_dance_1', 1);
  });

  it('shows her state of each entry: baked plays, pending waits, failed says why', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue({
      ok: true,
      entries: [entry('mmd_a', '舞蹈甲', 'baked'), entry('mmd_b', '舞蹈乙', 'pending'), entry('mmd_c', '舞蹈丙', 'failed', 'missing_bones')],
    });
    await mount('&view=mmd');
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    expect(within(item('mmd_a')!).getByText('相机')).toBeTruthy();
    expect(within(item('mmd_a')!).getByRole('button', { name: '播放' })).toBeTruthy();
    expect(within(item('mmd_b')!).queryByRole('button', { name: '播放' })).toBeNull();
    expect(item('mmd_b')!.getAttribute('data-state')).toBe('pending');
    expect(within(item('mmd_c')!).queryByRole('button', { name: '播放' })).toBeNull();
    expect(item('mmd_c')!.textContent).toContain('这个角色的骨骼接不上 MMD 动作');
  });

  it('shows the sync while it runs and reads the lists again when it ends', async () => {
    let push: (s: MmdSyncState) => void = () => {};
    vi.spyOn(bridge.mmd, 'onSync').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    const list = vi.spyOn(bridge.mmd, 'list');
    const actions = vi.spyOn(bridge.avatar, 'actions');
    await mount('&view=mmd');
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole('status', { name: 'MMD 同步' })).toBeNull();
    await act(async () => push({ running: true, character: 'si', total: 3, done: 1, failed: 0, stage: null, fraction: 1 / 3 }));
    const bar = within(screen.getByRole('status', { name: 'MMD 同步' })).getByRole('progressbar', { name: '准备中 1/3' });
    expect(bar.getAttribute('aria-valuenow')).toBe('33');
    expect(bar.textContent).toBe('准备中 1/333%');
    await act(async () => push({ running: true, character: 'si', total: 3, done: 2, failed: 0, stage: 'write', fraction: 0.7 }));
    expect(screen.getByRole('progressbar', { name: '写入角色包 2/3' }).getAttribute('aria-valuenow')).toBe('70');
    const lists = list.mock.calls.length;
    const reads = actions.mock.calls.length;
    await act(async () => push({ running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 }));
    expect(screen.queryByRole('status', { name: 'MMD 同步' })).toBeNull();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(lists));
    await waitFor(() => expect(actions.mock.calls.length).toBeGreaterThan(reads));
  });

  it('bakes a dance into the next character after a switch on the fake', async () => {
    await bridge.mmd.import();
    const seen: boolean[] = [];
    const off = bridge.mmd.onSync((s) => seen.push(s.running));
    await bridge.character.switchTo('voice_a');
    await waitFor(() => expect(seen).toEqual([true, false]), SLOW);
    off();
    const r = await bridge.mmd.list();
    expect(r.ok && r.entries[0]?.characters.find((c) => c.id === 'voice_a')?.state).toBe('baked');
  });

  it('renames and deletes an entry; the delete says every character loses it', async () => {
    const rename = vi.spyOn(bridge.character, 'renameMotion');
    const remove = vi.spyOn(bridge.character, 'removeMotion');
    await bridge.mmd.import();
    await mount('&view=mmd');
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    await click(within(item('mmd_dance_1')!).getByRole('button', { name: '改名' }));
    const input = within(screen.getByRole('dialog', { name: '改名' })).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('示例舞蹈');
    fireEvent.change(input, { target: { value: '慢舞' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(rename).toHaveBeenCalledWith('mmd_dance_1', '慢舞');
    await waitFor(() => expect(item('mmd_dance_1')?.textContent).toContain('慢舞'));
    await click(within(item('mmd_dance_1')!).getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除动作' });
    expect(dialog.textContent).toContain('每个角色');
    await click(within(dialog).getByRole('button', { name: '删除' }));
    expect(remove).toHaveBeenCalledWith('mmd_dance_1');
    await waitFor(() => expect(item('mmd_dance_1')).toBeNull());
  });

  it('has the MMD 列表 with her mmd_ actions', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { ...MMD_ACTION }]);
    await mount('&view=mmd');
    const list = await screen.findByRole('region', { name: 'MMD 列表' });
    expect(view()!.contains(list)).toBe(true);
    expect(list.querySelector('[data-playlist-row="mmd_a"]')?.textContent).toContain('舞蹈甲');
  });
});

describe('motion tabs without MMD dances', () => {
  it('the 动作 table and its tab leave out mmd_ rows and the MMD 列表', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { ...MMD_ACTION }]);
    await mount();
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
    await mount('&pane=import');
    const list = await screen.findByRole('list', { name: '导入的动作' });
    expect(Array.from(list.querySelectorAll('[data-imported-motion]')).map((e) => e.getAttribute('data-imported-motion'))).toEqual(['bvh_walk']);
  });
});
