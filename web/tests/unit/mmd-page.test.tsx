// 角色 › MMD: the MMD library every character shares (mmd.list/import/syncState/onSync) in the section panel beside the
// character area's live preview stage, her setlist under the stage.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarAction, AgenticComplexBridge, MmdEntry, MmdSyncState } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { Library } from '../../src/pages/mmd/Library';
import { findRoute } from '../../src/shell/registry';
import { createAppRouter } from '../../src/shell/router';
import { stubMatchMedia } from './mediaStub';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

const RECT = { x: 400, y: 80, width: 360, height: 640, top: 80, left: 400, right: 760, bottom: 720, toJSON: () => ({}) } as DOMRect;
const EMPTY = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
const MMD_ACTION: AvatarAction = { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 12, playable: true };
const entry = (id: string, title: string, state: 'baked' | 'pending' | 'failed', reason: string | null = null): MmdEntry => ({
  id, title, durationS: 12.5, hasBgm: true, hasCamera: id === 'mmd_a', hasFace: false, project: null, role: null, createdAt: '2026-11-17T10:00:00+00:00',
  characters: [{ id: 'si', state, reason }, { id: 'voice_a', state: 'pending', reason: null }],
});
const THREE = { ok: true as const, entries: [entry('mmd_a', '舞蹈甲', 'baked'), entry('mmd_b', '舞蹈乙', 'pending'), entry('mmd_c', '舞蹈丙', 'failed', 'missing_bones')] };

function install(over: Partial<Parameters<typeof createFakeBridge>[0]> = {}) {
  bridge = createFakeBridge({ surface: 'main', still: true, ...over });
  window.agenticComplex = bridge;
}

/** 角色 opened on its MMD section; `ready: false` does not wait for the library panel. */
async function mount(ready = true) {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1&view=mmd'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  if (ready) await screen.findByRole('region', { name: 'MMD 库' });
  else await waitFor(() => expect(document.querySelector('[data-page="character"]')).not.toBeNull());
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const item = (id: string) => document.querySelector<HTMLElement>(`[data-mmd="${id}"]`);
const rowKey = (id: string) => item(id)!.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
const pick = (id: string) => click(rowKey(id));
const press = (el: Element, key: string, opts: Partial<KeyboardEventInit> = {}) => act(async () => void fireEvent.keyDown(el, { key, ...opts }));
// The selected row's opened part.
const detail = () => screen.getByRole('group', { name: 'MMD 操作' });
const importKey = () => screen.getByRole('button', { name: /^导入(中…| MMD)$/ }) as HTMLButtonElement;
// The selected dance's other characters leave her out: who the section is for.
const herName = () => within(detail()).getByRole('list', { name: '其他角色' }).textContent;
// The fake import takes a second.
const SLOW = { timeout: 3000 };
/** The fake's project scanned and its first body imported as 示例舞蹈 (`mmd_dance_1`). */
async function importOne() {
  const r = await bridge.mmd.scan({ folder: false });
  if (!r.ok) throw new Error(r.reason);
  await bridge.mmd.importScan({ token: r.token, items: [{ body: 0, title: '示例舞蹈' }], face: null, camera: null, audio: 0, bgmStartS: null, project: '示例' });
}

beforeEach(() => install());
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('MMD section', () => {
  it('is no page of its own: /mmd is not found', async () => {
    expect(findRoute('/mmd')).toBeUndefined();
    stubMatchMedia();
    window.location.hash = '#/mmd?still=1';
    const router = createAppRouter();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: '没有这个页面' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/mmd');
    window.location.hash = '';
  });

  it('stands on the character area’s training room with its one live preview stage, beside the rail', async () => {
    await mount();
    expect(document.querySelector('[data-page="character"] [data-training-room]')).not.toBeNull();
    expect(document.querySelectorAll('[data-preview-stage]').length).toBe(1);
    expect(screen.getByRole('navigation', { name: '角色分区' })).toBeTruthy();
  });
});

describe('MMD library', () => {
  it('imports a project: its 确认单, the result line, then the entry baked for her with its part and marks, played on the desktop', async () => {
    const imp = vi.spyOn(bridge.mmd, 'importScan');
    const play = vi.spyOn(bridge.avatar, 'playAction');
    await mount();
    await click(await screen.findByRole('button', { name: '导入 MMD' }));
    await click(within(await screen.findByRole('dialog', { name: '导入 MMD' })).getByRole('button', { name: '导入' }));
    expect(imp).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '导入中…' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull(), SLOW);
    expect(document.querySelector('[data-motion-import]')?.textContent).toBe('已导入「愛包ダンスホール · HimeTanaka」');
    const row = item('mmd_dance_1')!;
    expect(row.textContent).toContain('愛包ダンスホール · HimeTanaka');
    expect(row.textContent).toContain('223.3 s');
    expect(within(row).getByText('HimeTanaka')).toBeTruthy();
    expect(within(row).getByText('BGM')).toBeTruthy();
    expect(within(row).getByText('CAM')).toBeTruthy();
    expect(within(row).getByText('LIP')).toBeTruthy();
    await pick('mmd_dance_1');
    await click(within(detail()).getByRole('button', { name: '桌面播放' }));
    expect(play).toHaveBeenCalledWith('mmd_dance_1', 1);
  });

  it('shows her state of each entry: baked plays, pending waits, failed says why in its row', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    expect(within(item('mmd_a')!).getByText('CAM')).toBeTruthy();
    expect(item('mmd_a')!.getAttribute('data-state')).toBe('baked');
    expect(within(detail()).getByRole('button', { name: '桌面播放' })).toBeTruthy();
    expect(item('mmd_b')!.getAttribute('data-state')).toBe('pending');
    expect(item('mmd_b')!.textContent).toContain('待同步');
    await pick('mmd_b');
    expect(item('mmd_b')!.contains(detail())).toBe(true);
    expect(within(detail()).queryByRole('button', { name: '桌面播放' })).toBeNull();
    expect(within(detail()).getByRole('button', { name: '改名' })).toBeTruthy();
    expect(item('mmd_c')!.textContent).toContain('这个角色的骨骼接不上 MMD 动作');
    await pick('mmd_c');
    expect(within(detail()).queryByRole('button', { name: '桌面播放' })).toBeNull();
  });

  it('filters the rows by 全部 / 可播放 / 未就绪 with their counts, and draws no tabs when every dance stands the same', async () => {
    const list = vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    const tabs = screen.getByRole('tablist', { name: '筛选' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['全部[3]', '可播放[1]', '未就绪[2]']);
    await click(within(tabs).getByRole('tab', { name: /可播放/ }));
    expect([item('mmd_a'), item('mmd_b'), item('mmd_c')].map((e) => e != null)).toEqual([true, false, false]);
    await click(within(tabs).getByRole('tab', { name: /未就绪/ }));
    expect([item('mmd_a'), item('mmd_b'), item('mmd_c')].map((e) => e != null)).toEqual([false, true, true]);
    expect(item('mmd_b')!.contains(detail())).toBe(true);
    cleanup();
    list.mockResolvedValue({ ok: true, entries: [entry('mmd_a', '舞蹈甲', 'baked')] });
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    expect(screen.queryByRole('tablist', { name: '筛选' })).toBeNull();
  });

  it('says how the selected dance stands on each other character, with the reason of a failure', async () => {
    const other = { ...entry('mmd_a', '舞蹈甲', 'baked'), characters: [{ id: 'si', state: 'baked' as const, reason: null }, { id: 'voice_a', state: 'failed' as const, reason: 'missing_bones' }] };
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [other] });
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    const others = within(detail()).getByRole('list', { name: '其他角色' });
    const names = within(others).getAllByRole('listitem');
    expect(names.map((n) => n.getAttribute('data-state'))).toEqual(['failed', 'pending']);
    expect(names[0]!.textContent).toBe('示例甲这个角色的骨骼接不上 MMD 动作');
    expect(names[1]!.textContent).toBe('示例丙待同步');
    expect(others.textContent).not.toContain('示例乙');
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
    const strip = screen.getByRole('status', { name: 'MMD 同步' });
    const bar = within(strip).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('33');
    expect(strip.textContent).toBe('同步曲库到 示例乙准备中SYNC1/3正在载入33%');
    await act(async () => push({ running: true, character: 'si', total: 3, done: 2, failed: 0, stage: 'write', fraction: 0.7 }));
    expect(strip.textContent).toContain('写入角色包SYNC2/3');
    expect(within(strip).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('70');
    const lists = list.mock.calls.length;
    const reads = actions.mock.calls.length;
    await act(async () => push({ running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 }));
    expect(screen.queryByRole('status', { name: 'MMD 同步' })).toBeNull();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(lists));
    await waitFor(() => expect(actions.mock.calls.length).toBeGreaterThan(reads));
  });

  it('says one thing at a time on the strip: a running import over the sync, and the import result folds away on the next pick', async () => {
    let sync: (s: MmdSyncState) => void = () => {};
    vi.spyOn(bridge.mmd, 'onSync').mockImplementation((cb) => {
      sync = cb;
      return () => {};
    });
    await mount();
    await act(async () => sync({ running: true, character: 'si', total: 3, done: 1, failed: 0, stage: 'write', fraction: 0.3 }));
    await click(screen.getByRole('button', { name: '导入 MMD' }));
    await click(within(await screen.findByRole('dialog', { name: '导入 MMD' })).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'MMD 导入' }).textContent).toContain('正在导入「愛包ダンスホール · HimeTanaka」'));
    expect(screen.queryByRole('status', { name: 'MMD 同步' })).toBeNull();
    await act(async () => sync({ running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 }));
    await waitFor(() => expect(document.querySelector('[data-motion-import]')).not.toBeNull(), SLOW);
    expect(screen.queryByRole('status', { name: 'MMD 导入' })).toBeNull();
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    await pick('mmd_dance_1');
    expect(document.querySelector('[data-motion-import]')).toBeNull();
  });

  it('bakes a dance into the next character after a switch on the fake', async () => {
    await importOne();
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
    await importOne();
    await mount();
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    await pick('mmd_dance_1');
    await click(within(detail()).getByRole('button', { name: '改名' }));
    const input = within(screen.getByRole('dialog', { name: '改名' })).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('示例舞蹈');
    fireEvent.change(input, { target: { value: '慢舞' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(rename).toHaveBeenCalledWith('si', 'mmd_dance_1', '慢舞');
    await waitFor(() => expect(item('mmd_dance_1')?.textContent).toContain('慢舞'));
    await click(within(detail()).getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除动作' });
    expect(dialog.textContent).toContain('每个角色');
    await click(within(dialog).getByRole('button', { name: '删除' }));
    expect(remove).toHaveBeenCalledWith('si', 'mmd_dance_1');
    await waitFor(() => expect(item('mmd_dance_1')).toBeNull());
  });

  it('moves the selection with ↑ ↓, adds with Enter, renames with F2 and asks to delete with Delete', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    vi.spyOn(bridge.avatar, 'actions').mockResolvedValue([{ ...MMD_ACTION }]);
    const set = vi.spyOn(bridge.character, 'setPlaylist').mockResolvedValue({ ok: true });
    await mount();
    await waitFor(() => expect(within(item('mmd_a')!).queryByRole('button', { name: '加入演出列表' })).not.toBeNull());
    await press(rowKey('mmd_a'), 'ArrowDown');
    expect(rowKey('mmd_b').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(rowKey('mmd_b'));
    await press(rowKey('mmd_b'), 'ArrowUp');
    expect(rowKey('mmd_a').getAttribute('aria-pressed')).toBe('true');
    await press(rowKey('mmd_a'), 'Enter');
    expect(set).toHaveBeenLastCalledWith('si', { items: ['mmd_a'], loop: 'off', speed: 1 });
    await press(rowKey('mmd_a'), 'F2');
    expect(screen.getByRole('dialog', { name: '改名' })).toBeTruthy();
    await click(within(screen.getByRole('dialog', { name: '改名' })).getByRole('button', { name: '取消' }));
    await press(rowKey('mmd_a'), 'Delete');
    expect(screen.getByRole('dialog', { name: '删除动作' })).toBeTruthy();
  });

  it('draws her 演出列表 under the stage with only the dances in it; a row’s ＋ adds one and shows its place', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { ...MMD_ACTION }]);
    const set = vi.spyOn(bridge.character, 'setPlaylist').mockResolvedValue({ ok: true });
    await mount();
    const band = await screen.findByRole('region', { name: 'MMD 列表' });
    expect(screen.getByRole('region', { name: 'MMD 库' }).contains(band)).toBe(false);
    expect(band.textContent).toContain('列表是空的');
    expect(band.querySelector('[data-playlist-row]')).toBeNull();
    // Not baked for her: not hers, so no ＋.
    expect(within(item('mmd_b')!).queryByRole('button', { name: '加入演出列表' })).toBeNull();
    await click(within(item('mmd_a')!).getByRole('button', { name: '加入演出列表' }));
    expect(set).toHaveBeenLastCalledWith('si', { items: ['mmd_a'], loop: 'off', speed: 1 });
    expect(band.querySelector('[data-playlist-row="mmd_a"]')?.textContent).toContain('舞蹈甲');
    expect(band.textContent).toContain('1 首 │ 共 12.5 s');
    expect(within(item('mmd_a')!).queryByRole('button', { name: '加入演出列表' })).toBeNull();
    expect(item('mmd_a')!.textContent).toContain('01');
  });
});

describe('MMD stage preview', () => {
  function stage() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'previewStage' in this.dataset || 'previewLayer' in this.dataset ? RECT : EMPTY;
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

  it('says the 播放方式 is the stage’s alone when the avatar cannot loop', async () => {
    install({ capabilities: { actionLoop: false } });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    expect(within(detail()).getByRole('button', { name: '桌面播放' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '播放方式' })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: '舞台播放方式' })).toBeTruthy();
  });

  it('puts no control inside the stage while she is drawn there', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    const st = document.querySelector('[data-preview-stage]')!;
    expect(st.querySelectorAll(':is(button, [role="radio"], input, a):not([hidden])').length).toBe(0);
  });
});

describe('MMD section · whose it is', () => {
  const B_ACTION: AvatarAction = { ...MMD_ACTION, id: 'mmd_b', label: '舞蹈乙' };

  it('follows a switch the shell pushes: her name, her actions and her own list, which a change then writes', async () => {
    let who = 'si';
    const lists: Record<string, string[]> = { si: ['mmd_a'], voice_a: ['mmd_b'] };
    let push: (s: Awaited<ReturnType<AgenticComplexBridge['app']['runtime']>>) => void = () => {};
    vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [{ ...MMD_ACTION }, { ...B_ACTION }]);
    vi.spyOn(bridge.character, 'getPlaylist').mockImplementation(async () => ({ items: [...lists[who]!], loop: 'off', speed: 1 }));
    const set = vi.spyOn(bridge.character, 'setPlaylist').mockResolvedValue({ ok: true });
    const rt = await bridge.app.runtime();
    await mount();
    const list = await screen.findByRole('region', { name: 'MMD 列表' });
    expect(list.textContent).toContain('示例乙');
    await waitFor(() => expect(list.querySelector('[data-playlist-row="mmd_a"]')).not.toBeNull());
    await bridge.character.switchTo('voice_a');
    who = 'voice_a';
    await act(async () => push({ ...rt, character: { ...rt.character, current: 'voice_a', shown: 'voice_a', agentd: 'voice_a' } }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'MMD 列表' }).textContent).toContain('示例甲'));
    const after = screen.getByRole('region', { name: 'MMD 列表' });
    await waitFor(() => expect(after.querySelector('[data-playlist-row="mmd_b"]')).not.toBeNull());
    expect(after.querySelector('[data-playlist-row="mmd_a"]')).toBeNull();
    await click(within(within(after).getByRole('radiogroup', { name: '连播速度' })).getByRole('radio', { name: '2×' }));
    expect(set).toHaveBeenLastCalledWith('voice_a', { items: ['mmd_b'], loop: 'off', speed: 2 });
  });

  it('waits for the roster before it says how a dance stands for her, and offers no import meanwhile', async () => {
    vi.spyOn(bridge.character, 'list').mockReturnValue(new Promise(() => {}));
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount(false);
    await act(async () => {});
    expect(item('mmd_a')).toBeNull();
    expect(screen.queryByRole('button', { name: /^导入(中…| MMD)$/ })).toBeNull();
  });

  it('says the roster read failed in the page’s bar and reads it again on 重试', async () => {
    const roster = vi.spyOn(bridge.character, 'list').mockRejectedValue({ code: 'failed' });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount(false);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('读取角色目录失败'));
    expect(item('mmd_a')).toBeNull();
    expect(screen.queryByRole('region', { name: 'MMD 库' })).toBeNull();
    const n = roster.mock.calls.length;
    await click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(roster.mock.calls.length).toBeGreaterThan(n));
  });

  it('offers no import VMD without a character, only the page’s 导入角色', async () => {
    vi.spyOn(bridge.character, 'list').mockResolvedValue([]);
    await mount(false);
    await screen.findByRole('button', { name: '导入角色' });
    expect(screen.queryByRole('button', { name: /^导入(中…| MMD)$/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'MMD 列表' })).toBeNull();
  });
});

describe('MMD section · minor review findings', () => {
  it('says the bridge’s failure of a retry, not the reason of the read before it', () => {
    render(<Library data={{ ok: false, reason: 'bad_zip', detail: '' }} error="not_implemented" onRetry={() => {}} current="si" sel={undefined} onPick={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('读取 MMD 库失败：这个版本还不支持');
  });

  it('marks a failed dance’s reason in danger in its row', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    expect(within(item('mmd_c')!).getByText('这个角色的骨骼接不上 MMD 动作').getAttribute('data-tone')).toBe('danger');
    expect(within(item('mmd_b')!).getByText('待同步').getAttribute('data-tone')).toBeNull();
  });

  it('offers no dance and no import without an avatar, and does not read the library', async () => {
    install({ capabilities: { avatar: false } });
    const list = vi.spyOn(bridge.mmd, 'list');
    await mount();
    expect(importKey().disabled).toBe(true);
    expect(within(screen.getByRole('region', { name: 'MMD 库' })).getByText('桌面角色没有接入')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('drops the selected dance’s actions when a later library read fails', async () => {
    const list = vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({ component: CharacterPage });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1&view=mmd'] }) });
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(within(detail()).getByRole('button', { name: '改名' })).toBeTruthy());
    list.mockRejectedValue({ code: 'failed' });
    await act(async () => void (await qc.refetchQueries({ queryKey: ['mmd', 'list'] })));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'MMD 库' })).getByRole('alert')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull();
  });

  it('does not bring back an old stage preview when she comes back after a switch', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'previewStage' in this.dataset || 'previewLayer' in this.dataset ? RECT : EMPTY;
    });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const show = vi.spyOn(bridge.avatar.preview, 'show').mockImplementation(async (_at: PreviewPlacement) => true);
    let push: (s: Awaited<ReturnType<AgenticComplexBridge['app']['runtime']>>) => void = () => {};
    vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    const rt = await bridge.app.runtime();
    const at = (id: string) => ({ ...rt, character: { ...rt.character, current: id, shown: id, agentd: id } });
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    await pick('mmd_a');
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a' })));
    await act(async () => push(at('voice_a')));
    await waitFor(() => expect(herName()).not.toContain('示例甲'));
    await waitFor(() => expect(show.mock.lastCall?.[0]).not.toHaveProperty('action'));
    await act(async () => push(at('si')));
    await waitFor(() => expect(herName()).not.toContain('示例乙'));
    // The stage reports on the next animation frame.
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(show.mock.lastCall?.[0]).not.toHaveProperty('action');
  });
});

describe('MMD section · 播放方式', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'previewStage' in this.dataset || 'previewLayer' in this.dataset ? RECT : EMPTY;
    });
  });

  it('loops the stage even when the desktop avatar cannot loop', async () => {
    install({ capabilities: { actionLoop: false } });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const show = vi.spyOn(bridge.avatar.preview, 'show').mockImplementation(async (_at: PreviewPlacement) => true);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    await pick('mmd_a');
    await click(within(screen.getByRole('radiogroup', { name: '舞台播放方式' })).getByRole('radio', { name: '循环' }));
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a', loop: true })));
  });

  it('loops 桌面播放 too with 循环, and 停止 ends it', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const play = vi.spyOn(bridge.avatar, 'playAction');
    const stop = vi.spyOn(bridge.avatar, 'stopAction');
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    await click(within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name: '循环' }));
    await click(within(detail()).getByRole('button', { name: '桌面播放' }));
    expect(play).toHaveBeenCalledWith('mmd_a', 1, { loop: true });
    await click(await within(detail()).findByRole('button', { name: '停止' }));
    expect(stop).toHaveBeenCalled();
    expect(await within(detail()).findByRole('button', { name: '桌面播放' })).toBeTruthy();
  });
});
