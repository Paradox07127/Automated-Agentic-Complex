// MMD 页: the MMD library every character shares (mmd.list/import/syncState/onSync) beside the current character's live preview.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarAction, AgenticComplexBridge, MmdEntry, MmdSyncState } from '../../src/bridge/protocol';
import { MmdPage } from '../../src/pages/mmd/Page';
import { route } from '../../src/pages/mmd/route';
import { findRoute, pageRoutes } from '../../src/shell/registry';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

const RECT = { x: 400, y: 80, width: 360, height: 640, top: 80, left: 400, right: 760, bottom: 720, toJSON: () => ({}) } as DOMRect;
const EMPTY = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
const MMD_ACTION: AvatarAction = { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 12, playable: true };
const entry = (id: string, title: string, state: 'baked' | 'pending' | 'failed', reason: string | null = null): MmdEntry => ({
  id, title, durationS: 12.5, hasBgm: true, hasCamera: id === 'mmd_a', createdAt: '2026-11-17T10:00:00+00:00',
  characters: [{ id: 'si', state, reason }, { id: 'voice_a', state: 'pending', reason: null }],
});
const THREE = { ok: true as const, entries: [entry('mmd_a', '舞蹈甲', 'baked'), entry('mmd_b', '舞蹈乙', 'pending'), entry('mmd_c', '舞蹈丙', 'failed', 'missing_bones')] };

function install(over: Partial<Parameters<typeof createFakeBridge>[0]> = {}) {
  bridge = createFakeBridge({ surface: 'main', still: true, ...over });
  window.agenticComplex = bridge;
}

async function mount() {
  const root = createRootRoute({ component: MmdPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: 'MMD 库' });
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const item = (id: string) => document.querySelector<HTMLElement>(`[data-mmd="${id}"]`);
const pick = (id: string) => click(within(item(id)!).getByRole('button'));
const detail = () => screen.getByRole('complementary', { name: 'MMD 操作' });
// The fake import takes a second.
const SLOW = { timeout: 3000 };

beforeEach(() => install());
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('MMD page route', () => {
  it('registers /mmd as a secondary page right after 角色, without a hotkey', () => {
    expect(findRoute('/mmd')).toMatchObject({ id: 'mmd', title: 'MMD', group: 'secondary' });
    expect(route.hotkey).toBeUndefined();
    const ids = pageRoutes.map((r) => r.id);
    expect(ids[ids.indexOf('character') + 1]).toBe('mmd');
  });

  it('stands on the training room with a live preview stage', async () => {
    await mount();
    expect(document.querySelector('[data-page="mmd"] [data-training-room]')).not.toBeNull();
    expect(document.querySelector('[data-preview-stage]')).not.toBeNull();
  });
});

describe('MMD library', () => {
  it('imports a dance: the result line, then the entry baked for her with its BGM mark, played on the desktop', async () => {
    const imp = vi.spyOn(bridge.mmd, 'import');
    const play = vi.spyOn(bridge.avatar, 'playAction');
    await mount();
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
    await pick('mmd_dance_1');
    await click(within(detail()).getByRole('button', { name: '桌面预览' }));
    expect(play).toHaveBeenCalledWith('mmd_dance_1', 1);
  });

  it('shows her state of each entry: baked plays, pending waits, failed says why', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    expect(within(item('mmd_a')!).getByText('相机')).toBeTruthy();
    expect(item('mmd_a')!.getAttribute('data-state')).toBe('baked');
    expect(within(detail()).getByRole('button', { name: '桌面预览' })).toBeTruthy();
    expect(item('mmd_b')!.getAttribute('data-state')).toBe('pending');
    expect(item('mmd_b')!.textContent).toContain('待同步');
    await pick('mmd_b');
    expect(within(detail()).queryByRole('button', { name: '桌面预览' })).toBeNull();
    expect(detail().textContent).toContain('待同步');
    expect(item('mmd_c')!.textContent).toContain('这个角色的骨骼接不上 MMD 动作');
    await pick('mmd_c');
    expect(within(detail()).queryByRole('button', { name: '桌面预览' })).toBeNull();
  });

  it('shows the sync while it runs and reads the lists again when it ends', async () => {
    let push: (s: MmdSyncState) => void = () => {};
    vi.spyOn(bridge.mmd, 'onSync').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    const list = vi.spyOn(bridge.mmd, 'list');
    const actions = vi.spyOn(bridge.avatar, 'actions');
    await mount();
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

  it('renames and deletes the selected entry; the delete says every character loses it', async () => {
    const rename = vi.spyOn(bridge.character, 'renameMotion');
    const remove = vi.spyOn(bridge.character, 'removeMotion');
    await bridge.mmd.import();
    await mount();
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    await pick('mmd_dance_1');
    await click(within(detail()).getByRole('button', { name: '改名' }));
    const input = within(screen.getByRole('dialog', { name: '改名' })).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('示例舞蹈');
    fireEvent.change(input, { target: { value: '慢舞' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(rename).toHaveBeenCalledWith('mmd_dance_1', '慢舞');
    await waitFor(() => expect(item('mmd_dance_1')?.textContent).toContain('慢舞'));
    await click(within(detail()).getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除动作' });
    expect(dialog.textContent).toContain('每个角色');
    await click(within(dialog).getByRole('button', { name: '删除' }));
    expect(remove).toHaveBeenCalledWith('mmd_dance_1');
    await waitFor(() => expect(item('mmd_dance_1')).toBeNull());
  });

  it('has the MMD 列表 with her mmd_ actions', async () => {
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { ...MMD_ACTION }]);
    await mount();
    const list = await screen.findByRole('region', { name: 'MMD 列表' });
    expect(detail().contains(list)).toBe(true);
    expect(list.querySelector('[data-playlist-row="mmd_a"]')?.textContent).toContain('舞蹈甲');
  });
});

describe('MMD stage preview', () => {
  function stage() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'previewStage' in this.dataset ? RECT : EMPTY;
    });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    return vi.spyOn(bridge.avatar.preview, 'show').mockImplementation(async (_at: PreviewPlacement) => true);
  }

  it('plays a baked dance on the stage when it is selected, looped with 循环', async () => {
    const show = stage();
    await mount();
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(show.mock.calls.every(([at]) => !('action' in at))).toBe(true);
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    await pick('mmd_a');
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a' })));
    expect(show.mock.lastCall?.[0]).not.toHaveProperty('loop');
    await click(within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name: '循环' }));
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a', loop: true })));
  });

  it('does not preview a dance that is not baked for her', async () => {
    const show = stage();
    await mount();
    await waitFor(() => expect(item('mmd_b')).not.toBeNull());
    await pick('mmd_a');
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a' })));
    await pick('mmd_b');
    await waitFor(() => expect(show.mock.lastCall?.[0]).not.toHaveProperty('action'));
    await pick('mmd_c');
    await act(async () => {});
    expect(show.mock.lastCall?.[0]).not.toHaveProperty('action');
    expect(screen.queryByRole('radiogroup', { name: '播放方式' })).toBeNull();
  });

  it('has no 播放方式 when the avatar cannot loop', async () => {
    install({ capabilities: { actionLoop: false } });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    expect(within(detail()).getByRole('button', { name: '桌面预览' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '播放方式' })).toBeNull();
  });
});
