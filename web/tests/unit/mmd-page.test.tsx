// MMD page: the MMD library every character shares (mmd.list/detail/import/syncState/onSync) beside its own live preview stage,
// the timeline of the selected dance under the stage, her setlist under that, the inspector under the library.
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionProgress, PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarAction, AgenticComplexBridge, MmdEntry, MmdSyncState } from '../../src/bridge/protocol';
import { Library } from '../../src/pages/mmd/Library';
import { MmdPage } from '../../src/pages/mmd/Page';
import { setNavRouter } from '../../src/shell/nav';
import { findRoute, pageRoutes } from '../../src/shell/registry';
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

/** The MMD page; `ready: false` does not wait for the library panel. */
async function mount(search = '', ready = true) {
  const root = createRootRoute({ component: MmdPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  if (ready) await screen.findByRole('region', { name: 'MMD 舞蹈库' });
  else await waitFor(() => expect(document.querySelector('[data-page="mmd"]')).not.toBeNull());
  return router;
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const item = (id: string) => document.querySelector<HTMLElement>(`[data-mmd="${id}"]`);
const rowKey = (id: string) => item(id)!.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
const pick = (id: string) => click(rowKey(id));
const press = (el: Element, key: string, opts: Partial<KeyboardEventInit> = {}) => act(async () => void fireEvent.keyDown(el, { key, ...opts }));
const inspector = () => screen.getByRole('region', { name: '当前舞蹈' });
const ops = () => screen.getByRole('group', { name: 'MMD 操作' });
const timeline = () => screen.getByRole('region', { name: '时间线' });
const fact = (at: string) => inspector().querySelector<HTMLElement>(`[data-fact="${at}"]`);
const importKey = () => screen.getByRole('button', { name: /^导入(中…| MMD)$/ }) as HTMLButtonElement;
// The fake import takes a second.
const SLOW = { timeout: 3000 };
/** The fake's project scanned and its first body imported as 示例舞蹈 (`mmd_dance_1`), with its camera and music. */
async function importOne() {
  const r = await bridge.mmd.scan({ folder: false });
  if (!r.ok) throw new Error(r.reason);
  await bridge.mmd.importScan({ token: r.token, items: [{ body: 0, title: '示例舞蹈' }], face: null, camera: 0, audio: 0, bgmStartS: null, project: '示例' });
}
/** Every report the page listens for, pushed at once. */
function desktop() {
  const listeners = new Set<(p: ActionProgress | null) => void>();
  vi.spyOn(bridge.avatar, 'onActionProgress').mockImplementation((cb) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  });
  return (p: ActionProgress | null) => act(async () => listeners.forEach((l) => l(p)));
}
type StagePosition = Parameters<Parameters<AgenticComplexBridge['avatar']['preview']['onPosition']>[0]>[0];
/** Every stage position the page listens for, pushed at once. */
function previewAt() {
  const listeners = new Set<(p: StagePosition) => void>();
  vi.spyOn(bridge.avatar.preview, 'onPosition').mockImplementation((cb) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  });
  return (p: StagePosition) => act(async () => listeners.forEach((l) => l(p)));
}
const BAR = { x: 100, y: 0, width: 200, height: 40, top: 0, left: 100, right: 300, bottom: 40, toJSON: () => ({}) } as DOMRect;

beforeEach(() => install());
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('MMD page', () => {
  it('is a page of its own after 角色: #/mmd opens it with its library', async () => {
    expect(findRoute('/mmd')).toMatchObject({ title: 'MMD', icon: 'file' });
    const ids = pageRoutes.map((r) => r.id);
    expect(ids.indexOf('mmd')).toBe(ids.indexOf('character') + 1);
    stubMatchMedia();
    window.location.hash = '#/mmd?still=1';
    const router = createAppRouter();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('region', { name: 'MMD 舞蹈库' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/mmd');
  });

  it('opens from the MMD item of the 角色 rail', async () => {
    stubMatchMedia();
    window.location.hash = '#/character?still=1&theme=light';
    const router = createAppRouter();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const rail = await screen.findByRole('navigation', { name: '角色分区' });
    await click(within(rail).getByRole('button', { name: 'MMD' }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/mmd\?/));
    expect(new URLSearchParams(router.state.location.searchStr).get('theme')).toBe('light');
    expect(await screen.findByRole('region', { name: 'MMD 舞蹈库' })).toBeTruthy();
  });

  it('stands on the training room with its own live preview stage and no character rail', async () => {
    await mount();
    expect(document.querySelector('[data-page="mmd"] [data-training-room]')).not.toBeNull();
    expect(document.querySelectorAll('[data-preview-stage]').length).toBe(1);
    expect(screen.queryByRole('navigation', { name: '角色分区' })).toBeNull();
  });

  it('selects the dance a link names (?sel=)', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount('&sel=mmd_b');
    await waitFor(() => expect(item('mmd_b')).not.toBeNull());
    expect(rowKey('mmd_b').getAttribute('aria-pressed')).toBe('true');
    expect(inspector().getAttribute('data-mmd-detail')).toBe('mmd_b');
  });
});

describe('MMD inspector and timeline', () => {
  it('says what the selected dance holds: its file, the face, the camera, the music, each character and the unmapped morphs', async () => {
    await importOne();
    await mount();
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    await pick('mmd_dance_1');
    await waitFor(() => expect(fact('face')).not.toBeNull());
    expect(fact('source')!.textContent).toContain('示例舞蹈.vmd');
    expect(fact('face')!.textContent).toBe('口型3 种表情已映射沿用舞蹈眨眼动作');
    expect(fact('camera')!.textContent).toBe('镜头27 次切镜视场角 12–40°');
    expect(fact('bgm')!.textContent).toBe('音频song.wav偏移 0.000 s');
    expect(within(fact('characters')!).getAllByRole('listitem').map((c) => c.textContent)).toEqual(['示例乙已同步', '示例甲待同步', '示例丙待同步']);
    expect(fact('unmapped')!.textContent).toBe('未映射表情1 种：てへぺろ');
    expect(within(ops()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['更换音频', '重命名', '删除']);
  });

  it('draws the four lanes from mmd.detail: 600 mouth slices, a cut every 8 s, the music', async () => {
    await importOne();
    await mount();
    await waitFor(() => expect(timeline().querySelector('[data-lane="face"] svg')).not.toBeNull());
    const mouth = timeline().querySelector('[data-lane="face"] svg')!;
    expect(mouth.getAttribute('data-bins')).toBe('600');
    expect(mouth.querySelector('path')!.getAttribute('d')!.match(/M/g)).toHaveLength(600);
    expect(timeline().querySelectorAll('[data-lane="cam"] rect')).toHaveLength(27);
    expect(timeline().querySelector('[data-lane="bgm"] svg')!.getAttribute('data-bins')).toBe('600');
    expect(timeline().querySelector('[data-lane="body"]')).not.toBeNull();
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:00.0/ 3:43.3');
  });

  it('shows only the characters and the actions while no character has the dance baked', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [entry('mmd_b', '舞蹈乙', 'pending')] });
    const read = vi.spyOn(bridge.mmd, 'detail').mockResolvedValue({ ok: false, reason: 'not_baked' });
    await mount();
    await waitFor(() => expect(read).toHaveBeenCalledWith('mmd_b'));
    await act(async () => {});
    expect([...inspector().querySelectorAll('[data-fact]')].map((f) => f.getAttribute('data-fact'))).toEqual(['characters']);
    expect(within(ops()).getByRole('button', { name: '重命名' })).toBeTruthy();
  });

  it('follows the desktop while it plays the selected dance: DESKTOP, its clock and playhead, and its pause', async () => {
    const push = desktop();
    const control = vi.spyOn(bridge.avatar, 'controlAction').mockResolvedValue();
    await importOne();
    await mount();
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    expect(timeline().textContent).toContain('PREVIEW');
    expect(within(timeline()).getByRole('button', { name: '暂停' })).toHaveProperty('disabled', true);
    await push({ id: 'mmd_dance_1', tS: 84, durationS: 223.33, paused: false });
    expect(timeline().textContent).toContain('DESKTOP');
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('1:24.0/ 3:43.3');
    expect(within(timeline()).getByRole('slider', { name: '播放进度' }).getAttribute('aria-valuenow')).toBe('84');
    expect(document.querySelector('[data-preview-stage]')!.textContent).toContain('正在桌面端播放');
    expect(within(timeline()).getByRole('button', { name: '停止桌面播放' })).toBeTruthy();
    await click(within(timeline()).getByRole('button', { name: '暂停' }));
    expect(control).toHaveBeenCalledWith('pause');
    await press(within(timeline()).getByRole('slider', { name: '播放进度' }), 'ArrowRight');
    expect(control).toHaveBeenLastCalledWith('seek', 89);
    await push({ id: 'mmd_other', tS: 1, durationS: 9, paused: false });
    expect(timeline().textContent).toContain('PREVIEW');
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:00.0/ 3:43.3');
  });

  it('follows the stage preview of the selected dance: PREVIEW, its clock and playhead, its pause, a drag and ← → seek it', async () => {
    const push = previewAt();
    const control = vi.spyOn(bridge.avatar.preview, 'control').mockResolvedValue();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'transportBar' in this.dataset ? BAR : EMPTY;
    });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    expect(within(timeline()).getByRole('button', { name: '暂停' })).toHaveProperty('disabled', true);
    await push({ t: 7, duration: 30, playing: false, action: 'mmd_b' });
    expect(within(timeline()).getByLabelText('时钟').textContent).not.toContain('0:07.0');
    await push({ t: 4.2, duration: 12.4, playing: false, action: 'mmd_a' });
    expect(timeline().textContent).toContain('PREVIEW');
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:04.2/ 0:12.4');
    const slider = within(timeline()).getByRole('slider', { name: '播放进度' });
    expect(slider.getAttribute('aria-valuenow')).toBe('4.2');
    await click(within(timeline()).getByRole('button', { name: '继续' }));
    expect(control).toHaveBeenLastCalledWith({ op: 'resume' });
    await push({ t: 4.2, duration: 12.4, playing: true, action: 'mmd_a' });
    await click(within(timeline()).getByRole('button', { name: '暂停' }));
    expect(control).toHaveBeenLastCalledWith({ op: 'pause' });
    await press(slider, 'ArrowRight');
    expect(control).toHaveBeenLastCalledWith({ op: 'seek', at: 9.2 });
    await press(slider, 'ArrowLeft');
    expect(control).toHaveBeenLastCalledWith({ op: 'seek', at: 0 });
    await act(async () => {
      fireEvent.pointerDown(slider, { clientX: 200, pointerId: 1, button: 0 });
      fireEvent.pointerUp(slider, { clientX: 200, pointerId: 1, button: 0 });
    });
    expect(control).toHaveBeenLastCalledWith({ op: 'seek', at: 6.2 });
    await push(null);
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:00.0/ 0:12.5');
    expect(within(timeline()).getByRole('button', { name: '暂停' })).toHaveProperty('disabled', true);
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
    expect(document.querySelector('[data-motion-import]')?.textContent).toBe('已导入「サンプルダンス · SampleDancerA」');
    const row = item('mmd_dance_1')!;
    expect(row.textContent).toContain('サンプルダンス · SampleDancerA');
    expect(row.textContent).toContain('223.3 s');
    expect(within(row).getByText('SampleDancerA')).toBeTruthy();
    expect(within(row).getByText('BGM')).toBeTruthy();
    expect(within(row).getByText('CAM')).toBeTruthy();
    expect(within(row).getByText('LIP')).toBeTruthy();
    await pick('mmd_dance_1');
    await click(within(timeline()).getByRole('button', { name: '桌面播放' }));
    expect(play).toHaveBeenCalledWith('mmd_dance_1', 1);
  });

  it('shows her state of each entry: baked plays, pending waits, failed says why in its row', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    expect(within(item('mmd_a')!).getByText('CAM')).toBeTruthy();
    expect(item('mmd_a')!.getAttribute('data-state')).toBe('baked');
    expect(within(timeline()).getByRole('button', { name: '桌面播放' })).toBeTruthy();
    expect(item('mmd_b')!.getAttribute('data-state')).toBe('pending');
    expect(item('mmd_b')!.textContent).toContain('待同步');
    await pick('mmd_b');
    expect(inspector().getAttribute('data-mmd-detail')).toBe('mmd_b');
    expect(within(timeline()).queryByRole('button', { name: '桌面播放' })).toBeNull();
    expect(within(ops()).getByRole('button', { name: '重命名' })).toBeTruthy();
    expect(item('mmd_c')!.textContent).toContain('当前角色骨骼与该 MMD 动作不兼容');
    await pick('mmd_c');
    expect(within(timeline()).queryByRole('button', { name: '桌面播放' })).toBeNull();
  });

  it('filters the rows by 全部 / 可播放 with their counts and by the search, and draws no tabs when every dance stands the same', async () => {
    const list = vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    const tabs = screen.getByRole('tablist', { name: '筛选' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['全部[3]', '可播放[1]']);
    await click(within(tabs).getByRole('tab', { name: /可播放/ }));
    expect([item('mmd_a'), item('mmd_b'), item('mmd_c')].map((e) => e != null)).toEqual([true, false, false]);
    await click(within(tabs).getByRole('tab', { name: /全部/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索舞蹈' }), { target: { value: '乙' } });
    await waitFor(() => expect([item('mmd_a'), item('mmd_b'), item('mmd_c')].map((e) => e != null)).toEqual([false, true, false]));
    expect(inspector().getAttribute('data-mmd-detail')).toBe('mmd_b');
    cleanup();
    list.mockResolvedValue({ ok: true, entries: [entry('mmd_a', '舞蹈甲', 'baked')] });
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    expect(screen.queryByRole('tablist', { name: '筛选' })).toBeNull();
  });

  it('says how the selected dance stands on each character, with the reason of a failure', async () => {
    const other = { ...entry('mmd_a', '舞蹈甲', 'baked'), characters: [{ id: 'si', state: 'baked' as const, reason: null }, { id: 'voice_a', state: 'failed' as const, reason: 'missing_bones' }] };
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [other] });
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    const names = within(within(inspector()).getByRole('list', { name: '角色同步' })).getAllByRole('listitem');
    expect(names.map((n) => n.getAttribute('data-state'))).toEqual(['baked', 'failed', 'pending']);
    expect(names.map((n) => n.textContent)).toEqual(['示例乙已同步', '示例甲当前角色骨骼与该 MMD 动作不兼容', '示例丙待同步']);
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
    expect(strip.textContent).toBe('正在同步舞蹈库至 示例乙准备中SYNC1/3正在载入33%');
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
    await waitFor(() => expect(screen.getByRole('status', { name: 'MMD 导入' }).textContent).toContain('正在导入「サンプルダンス · SampleDancerA」'));
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
    await click(within(ops()).getByRole('button', { name: '重命名' }));
    const input = within(screen.getByRole('dialog', { name: '重命名' })).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('示例舞蹈');
    fireEvent.change(input, { target: { value: '慢舞' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(rename).toHaveBeenCalledWith('si', 'mmd_dance_1', '慢舞');
    await waitFor(() => expect(item('mmd_dance_1')?.textContent).toContain('慢舞'));
    await click(within(ops()).getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除动作' });
    expect(dialog.textContent).toContain('所有角色');
    await click(within(dialog).getByRole('button', { name: '删除' }));
    expect(remove).toHaveBeenCalledWith('si', 'mmd_dance_1');
    await waitFor(() => expect(item('mmd_dance_1')).toBeNull());
  });

  it('更换音频 keeps the dance selected under its id and reads its detail again for the new music', async () => {
    const setMedia = vi.spyOn(bridge.mmd, 'setMedia');
    const read = vi.spyOn(bridge.mmd, 'detail');
    await importOne();
    await mount();
    await waitFor(() => expect(item('mmd_dance_1')).not.toBeNull());
    await pick('mmd_dance_1');
    await waitFor(() => expect(fact('bgm')).not.toBeNull());
    const reads = read.mock.calls.length;
    await click(within(ops()).getByRole('button', { name: '更换音频' }));
    await click(within(screen.getByRole('dialog', { name: '更换音频' })).getByRole('button', { name: '选择音频' }));
    expect(setMedia).toHaveBeenCalledWith('mmd_dance_1', { bgm: 'pick', bgmStartS: null });
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads), SLOW);
    expect(read.mock.calls.at(-1)).toEqual(['mmd_dance_1']);
    expect(rowKey('mmd_dance_1').getAttribute('aria-pressed')).toBe('true');
    expect(inspector().getAttribute('data-mmd-detail')).toBe('mmd_dance_1');
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
    expect(screen.getByRole('dialog', { name: '重命名' })).toBeTruthy();
    await click(within(screen.getByRole('dialog', { name: '重命名' })).getByRole('button', { name: '取消' }));
    await press(rowKey('mmd_a'), 'Delete');
    expect(screen.getByRole('dialog', { name: '删除动作' })).toBeTruthy();
  });

  it('draws her 演出列表 under the timeline with only the dances in it; a row’s ＋ adds one and shows its place', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const real = bridge.avatar.actions.bind(bridge.avatar);
    vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [...(await real()), { ...MMD_ACTION }]);
    const set = vi.spyOn(bridge.character, 'setPlaylist').mockResolvedValue({ ok: true });
    await mount();
    const band = await screen.findByRole('region', { name: 'MMD 列表' });
    expect(screen.getByRole('region', { name: 'MMD 舞蹈库' }).contains(band)).toBe(false);
    expect(timeline().compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band.textContent).toContain('列表为空');
    expect(band.querySelector('[data-playlist-row]')).toBeNull();
    // Not baked for her: not hers, so no ＋.
    expect(within(item('mmd_b')!).queryByRole('button', { name: '加入演出列表' })).toBeNull();
    await click(within(item('mmd_a')!).getByRole('button', { name: '加入演出列表' }));
    expect(set).toHaveBeenLastCalledWith('si', { items: ['mmd_a'], loop: 'off', speed: 1 });
    expect(band.querySelector('[data-playlist-row="mmd_a"]')?.textContent).toContain('舞蹈甲');
    expect(band.textContent).toContain('1 项 │ 共 12.5 s');
    expect(within(item('mmd_a')!).queryByRole('button', { name: '加入演出列表' })).toBeNull();
    expect(item('mmd_a')!.textContent).toContain('01');
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

  it('previews the selected baked dance as the stage in the stage’s rect, looped with 循环', async () => {
    const show = stage();
    await mount();
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ x: 400, y: 80, w: 360, h: 640, action: 'mmd_a', stage: true })));
    expect(show.mock.lastCall?.[0]).not.toHaveProperty('loop');
    await click(within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name: '循环' }));
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a', loop: true, stage: true })));
  });

  it('does not preview a dance that is not baked for her', async () => {
    const show = stage();
    await mount();
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a' })));
    await pick('mmd_b');
    await waitFor(() => expect(show.mock.lastCall?.[0]).not.toHaveProperty('action'));
    expect(show.mock.lastCall?.[0]).not.toHaveProperty('stage');
    await pick('mmd_c');
    await act(async () => {});
    expect(show.mock.lastCall?.[0]).not.toHaveProperty('action');
    expect(screen.queryByRole('radiogroup', { name: '播放方式' })).toBeNull();
  });

  it('stops the preview while the desktop plays the selected dance', async () => {
    const push = desktop();
    const show = stage();
    const hide = vi.spyOn(bridge.avatar.preview, 'hide');
    await mount();
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a' })));
    await push({ id: 'mmd_a', tS: 3, durationS: 12.5, paused: false });
    await waitFor(() => expect(hide).toHaveBeenCalled());
  });

  it('says the 播放方式 is the stage’s alone when the avatar cannot loop', async () => {
    install({ capabilities: { actionLoop: false } });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    expect(within(timeline()).getByRole('button', { name: '桌面播放' })).toBeTruthy();
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

  it('previews for the character on the desktop: after a switch to one without the dance, her idle', async () => {
    const show = stage();
    let push: (s: Awaited<ReturnType<AgenticComplexBridge['app']['runtime']>>) => void = () => {};
    vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    const rt = await bridge.app.runtime();
    await mount();
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a' })));
    await act(async () => push({ ...rt, character: { ...rt.character, current: 'voice_a', shown: 'voice_a', agentd: 'voice_a' } }));
    await waitFor(() => expect(show.mock.lastCall?.[0]).not.toHaveProperty('action'));
  });
});

describe('MMD page · whose it is', () => {
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
    await mount();
    await act(async () => {});
    expect(item('mmd_a')).toBeNull();
    expect(importKey().disabled).toBe(true);
  });

  it('says the roster read failed in the page’s bar and reads it again on 重试', async () => {
    const roster = vi.spyOn(bridge.character, 'list').mockRejectedValue({ code: 'failed' });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount('', false);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('读取角色列表失败'));
    expect(item('mmd_a')).toBeNull();
    expect(screen.queryByRole('region', { name: 'MMD 舞蹈库' })).toBeNull();
    const n = roster.mock.calls.length;
    await click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(roster.mock.calls.length).toBeGreaterThan(n));
  });

  it('offers no import without a character', async () => {
    vi.spyOn(bridge.character, 'list').mockResolvedValue([]);
    await mount();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'MMD 舞蹈库' })).queryByText('当前无可用角色')).not.toBeNull());
    expect(importKey().disabled).toBe(true);
    expect(screen.queryByRole('region', { name: 'MMD 列表' })).toBeNull();
  });
});

describe('MMD page · minor review findings', () => {
  it('says the bridge’s failure of a retry, not the reason of the read before it', () => {
    render(<Library data={{ ok: false, reason: 'bad_zip', detail: '' }} error="not_implemented" onRetry={() => {}} current="si" sel={undefined} onPick={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('读取 MMD 舞蹈库失败：当前版本暂不支持');
  });

  it('marks a failed dance’s reason in danger in its row', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    await mount();
    await waitFor(() => expect(item('mmd_c')).not.toBeNull());
    expect(within(item('mmd_c')!).getByText('当前角色骨骼与该 MMD 动作不兼容').getAttribute('data-tone')).toBe('danger');
    expect(within(item('mmd_b')!).getByText('待同步').getAttribute('data-tone')).toBeNull();
  });

  it('offers no dance and no import without an avatar, and does not read the library', async () => {
    install({ capabilities: { avatar: false } });
    const list = vi.spyOn(bridge.mmd, 'list');
    await mount();
    expect(importKey().disabled).toBe(true);
    expect(within(screen.getByRole('region', { name: 'MMD 舞蹈库' })).getByText('未接入角色渲染进程')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('drops the selected dance’s inspector when a later library read fails', async () => {
    const list = vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({ component: MmdPage });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(within(ops()).getByRole('button', { name: '重命名' })).toBeTruthy());
    list.mockRejectedValue({ code: 'failed' });
    await act(async () => void (await qc.refetchQueries({ queryKey: ['mmd', 'list'] })));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'MMD 舞蹈库' })).getByRole('alert')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
    expect(screen.queryByRole('region', { name: '时间线' })).toBeNull();
  });
});

describe('MMD page · 播放方式', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return 'previewStage' in this.dataset ? RECT : EMPTY;
    });
  });

  it('loops the stage even when the desktop avatar cannot loop', async () => {
    install({ capabilities: { actionLoop: false } });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const show = vi.spyOn(bridge.avatar.preview, 'show').mockImplementation(async (_at: PreviewPlacement) => true);
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    await click(within(screen.getByRole('radiogroup', { name: '舞台播放方式' })).getByRole('radio', { name: '循环' }));
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mmd_a', loop: true })));
  });

  it('loops 桌面播放 too with 循环, and 停止桌面播放 ends it', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const play = vi.spyOn(bridge.avatar, 'playAction');
    const stop = vi.spyOn(bridge.avatar, 'stopAction');
    await mount();
    await waitFor(() => expect(item('mmd_a')).not.toBeNull());
    await click(within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name: '循环' }));
    await click(within(timeline()).getByRole('button', { name: '桌面播放' }));
    expect(play).toHaveBeenCalledWith('mmd_a', 1, { loop: true });
    await click(await within(timeline()).findByRole('button', { name: '停止桌面播放' }));
    expect(stop).toHaveBeenCalled();
    expect(await within(timeline()).findByRole('button', { name: '桌面播放' })).toBeTruthy();
  });
});

describe('MMD page · detail and playhead', () => {
  it('reads the selected dance’s detail again for the character a switch brings', async () => {
    let push: (s: Awaited<ReturnType<AgenticComplexBridge['app']['runtime']>>) => void = () => {};
    vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const read = vi.spyOn(bridge.mmd, 'detail').mockResolvedValue({ ok: false, reason: 'not_baked' });
    const rt = await bridge.app.runtime();
    await mount();
    await waitFor(() => expect(read).toHaveBeenCalledWith('mmd_a'));
    const reads = read.mock.calls.length;
    await bridge.character.switchTo('voice_a');
    await act(async () => push({ ...rt, character: { ...rt.character, current: 'voice_a', shown: 'voice_a', agentd: 'voice_a' } }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
  });

  it('does not read the detail again when the window regains focus', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue(THREE);
    const read = vi.spyOn(bridge.mmd, 'detail').mockResolvedValue({ ok: false, reason: 'not_baked' });
    await mount();
    await waitFor(() => expect(read).toHaveBeenCalledWith('mmd_a'));
    await act(async () => {});
    const reads = read.mock.calls.length;
    try {
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await act(async () => {});
      expect(read.mock.calls.length).toBe(reads);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it('drops the stage position of the dance before when another is picked', async () => {
    const push = previewAt();
    const other = { ...entry('mmd_d', '舞蹈丁', 'baked'), durationS: 30 };
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [entry('mmd_a', '舞蹈甲', 'baked'), other] });
    await mount();
    await waitFor(() => expect(item('mmd_d')).not.toBeNull());
    await push({ t: 4.2, duration: 12.4, playing: true, action: 'mmd_a' });
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:04.2/ 0:12.4');
    await pick('mmd_d');
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:00.0/ 0:30.0');
    // The old load still reports until the new one starts; it is not the new dance's position.
    await push({ t: 4.4, duration: 12.4, playing: true, action: 'mmd_a' });
    expect(within(timeline()).getByLabelText('时钟').textContent).toBe('0:00.0/ 0:30.0');
  });

  it('draws the mouth and music lanes on the same time axis as the ruler and the playhead', async () => {
    const push = desktop();
    await importOne();
    await mount();
    await waitFor(() => expect(timeline().querySelector('[data-lane="face"] svg')).not.toBeNull());
    const r = await bridge.mmd.list();
    const long = r.ok ? r.entries.find((e) => e.id === 'mmd_dance_1')!.durationS * 2 : 0;
    await push({ id: 'mmd_dance_1', tS: 1, durationS: long, paused: false });
    expect(timeline().querySelector<SVGElement>('[data-lane="face"] svg')!.style.width).toBe('50%');
    expect(timeline().querySelector<SVGElement>('[data-lane="bgm"] svg')!.style.width).toBe('50%');
  });
});
