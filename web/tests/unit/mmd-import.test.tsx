// MMD › 导入 MMD: mmd.scan, its 确认单 and the plan mmd.importScan gets; 取消 drops the scan; 换音源 runs mmd.setMedia.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, MmdEntry, MmdScan } from '../../src/bridge/protocol';
import { MmdPage } from '../../src/pages/mmd/Page';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

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
const sheet = () => screen.getByRole('dialog', { name: '导入 MMD' });
const body = (i: number) => sheet().querySelector<HTMLElement>(`[data-mmd-body="${i}"]`)!;
const tick = (i: number) => within(body(i)).getByRole('checkbox') as HTMLInputElement;
const field = (name: string) => within(sheet()).getByRole('textbox', { name }) as HTMLInputElement;
const chosen = (name: string) => within(sheet()).getByRole('button', { name }).textContent;
const SLOW = { timeout: 4000 };

async function open() {
  await click(await screen.findByRole('button', { name: '导入 MMD' }));
  return screen.findByRole('dialog', { name: '导入 MMD' });
}

async function choose(select: string, option: string) {
  await click(within(sheet()).getByRole('button', { name: select }));
  await click(within(screen.getByRole('listbox', { name: select })).getByRole('option', { name: option }));
}

/** The fake's scan with a third body of `durationS`; `suggested` overrides its choices. */
function withLong(durationS: number, suggested: Partial<MmdScan['suggested']> = {}) {
  const real = bridge.mmd.scan.bind(bridge.mmd);
  return vi.spyOn(bridge.mmd, 'scan').mockImplementation(async (o) => {
    const r = await real(o);
    if (!r.ok) return r;
    const long = { ...r.scan.bodies[0]!, path: '/tmp/long.vmd', name: 'long.vmd', label: 'Long', model: 'M', durationS };
    return { ...r, scan: { ...r.scan, bodies: [...r.scan.bodies, long], suggested: { ...r.scan.suggested, ...suggested } } };
  });
}

beforeEach(() => install());
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('导入 MMD 确认单', () => {
  it('opens on the scan’s choices: the song, its suggested body ticked, no face, its camera and music, the place frame’s offset', async () => {
    const scan = vi.spyOn(bridge.mmd, 'scan');
    await mount();
    await open();
    expect(scan).toHaveBeenCalledWith({ folder: false });
    expect(field('曲名').value).toBe('愛包ダンスホール');
    expect([tick(0).checked, tick(1).checked]).toEqual([true, false]);
    expect(body(0).textContent).toBe('HimeTanaka田中ヒメ ver1.20223.3 s');
    expect(chosen('口型')).toBe('口型无');
    expect(chosen('镜头')).toBe('镜头camera_v1.0.vmd');
    expect(chosen('音源')).toBe('音源愛包ダンスホール_inst.wav');
    expect(field('音乐偏移').value).toBe('-0.633');
    const fold = within(sheet()).getByRole('button', { name: /未使用的文件/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await click(fold);
    expect(within(sheet()).getByRole('list', { name: '未使用的文件' }).textContent).toBe('Readme.txt不是动作或音频pose_start.vmd没有关键帧');
  });

  it('imports the suggested body under the song’s title and its part, with the shared choices', async () => {
    const imp = vi.spyOn(bridge.mmd, 'importScan');
    await mount();
    await open();
    await click(within(sheet()).getByRole('button', { name: '导入' }));
    expect(imp).toHaveBeenCalledWith({ token: 'scan_1', items: [{ body: 0, title: '愛包ダンスホール · HimeTanaka' }], face: null, camera: 0, audio: 0,
      bgmStartS: -0.633, project: '愛包ダンスホール' });
    expect(screen.queryByRole('dialog', { name: '导入 MMD' })).toBeNull();
  });

  it('submits the bodies ticked, the renamed song, the choices changed and the offset typed', async () => {
    const imp = vi.spyOn(bridge.mmd, 'importScan');
    await mount();
    await open();
    await act(async () => void fireEvent.click(tick(1)));
    fireEvent.change(field('曲名'), { target: { value: ' 愛包 ' } });
    await choose('镜头', '无');
    fireEvent.change(field('音乐偏移'), { target: { value: '1.25' } });
    await click(within(sheet()).getByRole('button', { name: '导入' }));
    expect(imp).toHaveBeenCalledWith({ token: 'scan_1', items: [{ body: 0, title: '愛包 · HimeTanaka' }, { body: 1, title: '愛包 · SuzukiHina' }],
      face: null, camera: null, audio: 0, bgmStartS: 1.25, project: '愛包' });
    await waitFor(() => expect(document.querySelector('[data-mmd="mmd_dance_2"]')).not.toBeNull(), SLOW);
    expect(document.querySelector('[data-motion-import]')?.textContent).toBe('已导入「愛包 · HimeTanaka」「愛包 · SuzukiHina」');
  });

  it('without music sends no offset and greys the offset out; a single body takes the song’s title alone', async () => {
    const real = bridge.mmd.scan.bind(bridge.mmd);
    vi.spyOn(bridge.mmd, 'scan').mockImplementation(async (o) => {
      const r = await real(o);
      return r.ok ? { ...r, scan: { ...r.scan, bodies: [r.scan.bodies[1]!], suggested: { ...r.scan.suggested, body: 0 } } } : r;
    });
    const imp = vi.spyOn(bridge.mmd, 'importScan');
    await mount();
    await open();
    await choose('音源', '无');
    expect(field('音乐偏移').disabled).toBe(true);
    await click(within(sheet()).getByRole('button', { name: '导入' }));
    expect(imp).toHaveBeenCalledWith(expect.objectContaining({ items: [{ body: 0, title: '愛包ダンスホール' }], audio: null, bgmStartS: null }));
  });

  it('marks a body over 360 s in danger and does not let it be ticked; with only that one suggested nothing is ticked and 导入 waits', async () => {
    withLong(361, { body: 2 });
    await mount();
    await open();
    expect(body(2).getAttribute('data-tone')).toBe('danger');
    expect(tick(2).disabled).toBe(true);
    expect(tick(2).checked).toBe(false);
    expect(within(body(2)).getByText('361.0 s')).toBeTruthy();
    expect(tick(0).disabled).toBe(false);
    expect(within(sheet()).getByRole('button', { name: '导入' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => void fireEvent.click(tick(0)));
    expect(within(sheet()).getByRole('button', { name: '导入' }).getAttribute('aria-disabled')).toBeNull();
    cleanup();
    install();
    withLong(360);
    await mount();
    await open();
    expect(tick(2).disabled).toBe(false);
  });

  it('holds 导入 while the offset is not a number or the title is empty', async () => {
    await mount();
    await open();
    const go = () => within(sheet()).getByRole('button', { name: '导入' }).getAttribute('aria-disabled') === 'true';
    fireEvent.change(field('音乐偏移'), { target: { value: 'abc' } });
    expect(go()).toBe(true);
    fireEvent.change(field('音乐偏移'), { target: { value: '' } });
    expect(go()).toBe(false);
    fireEvent.change(field('曲名'), { target: { value: '  ' } });
    expect(go()).toBe(true);
  });

  it('取消 drops the scan and imports nothing', async () => {
    const drop = vi.spyOn(bridge.mmd, 'dropScan');
    const imp = vi.spyOn(bridge.mmd, 'importScan');
    await mount();
    await open();
    await click(within(sheet()).getByRole('button', { name: '取消' }));
    expect(drop).toHaveBeenCalledWith('scan_1');
    expect(imp).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '导入 MMD' })).toBeNull();
  });

  it('a press outside the sheet keeps it open with its choices', async () => {
    const drop = vi.spyOn(bridge.mmd, 'dropScan');
    await mount();
    const d = await open();
    fireEvent.change(field('曲名'), { target: { value: 'サンプル' } });
    await act(async () => void fireEvent.mouseDown(d.parentElement!));
    expect(drop).not.toHaveBeenCalled();
    expect(field('曲名').value).toBe('サンプル');
  });

  it('says what a scan failed for and opens no 确认单; a cancelled panel says nothing', async () => {
    const scan = vi.spyOn(bridge.mmd, 'scan').mockResolvedValue({ ok: false, reason: 'bad_zip', detail: 'x' });
    await mount();
    await click(screen.getByRole('button', { name: '导入 MMD' }));
    await waitFor(() => expect(document.querySelector('[data-motion-import]')?.textContent).toBe('没有读出这个 MMD 工程：压缩包打不开或不安全'));
    expect(screen.queryByRole('dialog')).toBeNull();
    scan.mockResolvedValue({ ok: false, reason: 'cancelled' });
    await click(screen.getByRole('button', { name: '导入 MMD' }));
    await waitFor(() => expect(document.querySelector('[data-motion-import]')).toBeNull());
  });

  it('says which dance stopped the import after the ones done', async () => {
    const done = { id: 'mmd_dance_1', title: '愛包ダンスホール · HimeTanaka', durationS: 223.3, hasBgm: true, format: 'vmd', warnings: [] };
    vi.spyOn(bridge.mmd, 'importScan').mockResolvedValue({ ok: false, reason: 'too_long', detail: '', actions: [done] });
    await mount();
    await open();
    await act(async () => void fireEvent.click(tick(1)));
    await click(within(sheet()).getByRole('button', { name: '导入' }));
    await waitFor(() => expect(document.querySelector('[data-motion-import]')?.textContent)
      .toBe('已导入「愛包ダンスホール · HimeTanaka」，「愛包ダンスホール · SuzukiHina」没有完成：动作超过 360 秒'));
  });

  it('选择其它音频 adds the picked file to 音源 and chooses it; 导入 sends its index; the sheet stays open', async () => {
    const pick = vi.spyOn(bridge.mmd, 'pickScanAudio');
    const imp = vi.spyOn(bridge.mmd, 'importScan');
    await mount();
    await open();
    await choose('音源', '无');
    await click(within(sheet()).getByRole('button', { name: '选择其它音频' }));
    expect(pick).toHaveBeenCalledWith('scan_1');
    await waitFor(() => expect(chosen('音源')).toBe('音源song.wav'));
    expect(field('音乐偏移').disabled).toBe(false);
    await click(within(sheet()).getByRole('button', { name: '音源' }));
    expect(within(screen.getByRole('listbox', { name: '音源' })).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['无', '愛包ダンスホール_inst.wav', 'song.wav']);
    await click(within(sheet()).getByRole('button', { name: '音源' }));
    await click(within(sheet()).getByRole('button', { name: '导入' }));
    expect(imp).toHaveBeenCalledWith(expect.objectContaining({ token: 'scan_1', audio: 1 }));
  });

  it('a cancelled 选择其它音频 leaves 音源 as it was', async () => {
    vi.spyOn(bridge.mmd, 'pickScanAudio').mockResolvedValue({ ok: false, reason: 'cancelled' });
    await mount();
    await open();
    await click(within(sheet()).getByRole('button', { name: '选择其它音频' }));
    expect(chosen('音源')).toBe('音源愛包ダンスホール_inst.wav');
    await click(within(sheet()).getByRole('button', { name: '音源' }));
    expect(within(screen.getByRole('listbox', { name: '音源' })).getAllByRole('option')).toHaveLength(2);
    expect(document.querySelector('[data-motion-import]')).toBeNull();
  });

  it('offers 选择文件 and 选择文件夹 where one panel cannot take both', async () => {
    install({ capabilities: { filesOrFolderPicker: false } });
    const scan = vi.spyOn(bridge.mmd, 'scan');
    await mount();
    await click(screen.getByRole('button', { name: '导入 MMD' }));
    await click(screen.getByRole('menuitem', { name: '选择文件夹' }));
    expect(scan).toHaveBeenLastCalledWith({ folder: true });
    await click(within(await screen.findByRole('dialog', { name: '导入 MMD' })).getByRole('button', { name: '取消' }));
    await click(screen.getByRole('button', { name: '导入 MMD' }));
    await click(screen.getByRole('menuitem', { name: '选择文件' }));
    expect(scan).toHaveBeenLastCalledWith({ folder: false });
  });
});

describe('换音源', () => {
  const DANCE: MmdEntry = { id: 'mmd_dance_1', title: '愛包', durationS: 223.3, hasBgm: true, hasCamera: true, hasFace: true, project: '愛包',
    role: 'HimeTanaka', createdAt: '2026-11-25T10:00:00+00:00', characters: [{ id: 'si', state: 'baked', reason: null }] };

  it('picks new music at the offset typed, or takes the music away', async () => {
    vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [DANCE] });
    const set = vi.spyOn(bridge.mmd, 'setMedia').mockResolvedValue({ ok: true, action: { id: 'mmd_dance_1', title: '愛包', durationS: 223.3, hasBgm: true,
      format: 'vmd', warnings: [] } });
    await mount();
    const detail = await screen.findByRole('group', { name: 'MMD 操作' });
    await click(within(detail).getByRole('button', { name: '换音源' }));
    let dialog = screen.getByRole('dialog', { name: '换音源' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '音乐偏移' }), { target: { value: '-0.5' } });
    await click(within(dialog).getByRole('button', { name: '选择音频' }));
    expect(set).toHaveBeenLastCalledWith('mmd_dance_1', { bgm: 'pick', bgmStartS: -0.5 });
    await waitFor(() => expect(document.querySelector('[data-motion-import]')?.textContent).toBe('「愛包」换了音源'));
    await click(within(screen.getByRole('group', { name: 'MMD 操作' })).getByRole('button', { name: '换音源' }));
    dialog = screen.getByRole('dialog', { name: '换音源' });
    await click(within(dialog).getByRole('radio', { name: '不要音源' }));
    expect((within(dialog).getByRole('textbox', { name: '音乐偏移' }) as HTMLInputElement).disabled).toBe(true);
    await click(within(dialog).getByRole('button', { name: '去掉音源' }));
    expect(set).toHaveBeenLastCalledWith('mmd_dance_1', { bgm: 'none', bgmStartS: null });
  });
});
