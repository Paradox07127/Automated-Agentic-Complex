// Review 11-22 (3b1a#7, #8): the MMD section's desktop loop belongs to her and that dance; her list is not edited before it is read, and only the latest save rolls back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, AvatarAction, CharacterEntry, MmdEntry, MotionPlaylist } from '../../src/bridge/protocol';
import { useMmdSection, type MmdSectionProps } from '../../src/pages/mmd/Section';
import { useSetlist } from '../../src/pages/mmd/useSetlist';

let bridge: AgenticComplexBridge;

const ROSTER: CharacterEntry[] = [
  { id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: [] },
  { id: 'voice_a', name: '示例甲', en: 'VA', active: false, voice: true, appearances: [] },
];
const baked = (id: string, title: string): MmdEntry => ({
  id, title, durationS: 10, hasBgm: false, hasCamera: false, createdAt: '',
  characters: ROSTER.map((c) => ({ id: c.id, state: 'baked' as const, reason: null })),
});
const ACTIONS: AvatarAction[] = [
  { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 10, playable: true },
  { id: 'mmd_b', label: '舞蹈乙', enabled: true, section: 'idle', durationS: 10, playable: true },
];
const SYNC = { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 };

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [baked('mmd_a', '舞蹈甲'), baked('mmd_b', '舞蹈乙')] });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

function Section(p: MmdSectionProps) {
  return useMmdSection(p).node;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = (over: Partial<MmdSectionProps> = {}): MmdSectionProps => ({ on: true, roster: ROSTER, ch: ROSTER[0], actions: ACTIONS, offline: false, switching: false, sync: SYNC, toast: vi.fn(), ...over });
  const at = (over?: Partial<MmdSectionProps>) => (
    <QueryClientProvider client={client}>
      <Section {...props(over)} />
    </QueryClientProvider>
  );
  const ui = render(at());
  return { rerender: (over?: Partial<MmdSectionProps>) => ui.rerender(at(over)) };
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const detail = () => screen.getByRole('group', { name: 'MMD 操作' });
const desk = (name: '桌面播放' | '停止') => within(detail()).queryByRole('button', { name }) as HTMLButtonElement | null;

/** Loops mmd_a on the desktop, as 循环 then 桌面播放 do. */
async function loopA() {
  await waitFor(() => expect(document.querySelector('[data-mmd="mmd_a"]')).not.toBeNull());
  await click(within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name: '循环' }));
  await click(desk('桌面播放')!);
  await waitFor(() => expect(desk('停止')).not.toBeNull());
}

describe('MMD · 停止 belongs to the loop it stops', () => {
  it('drops 停止 when the avatar goes offline, and does not bring it back when she runs again', async () => {
    const m = mount();
    await loopA();
    m.rerender({ offline: true });
    expect(desk('停止')).toBeNull();
    expect(desk('桌面播放')!.disabled).toBe(true);
    m.rerender();
    expect(desk('停止')).toBeNull();
  });

  it('drops 停止 after a switch to another character', async () => {
    const m = mount();
    await loopA();
    m.rerender({ ch: ROSTER[1] });
    await waitFor(() => expect(detail().getAttribute('data-mmd-detail')).toBe('mmd_a'));
    expect(desk('停止')).toBeNull();
    expect(desk('桌面播放')).not.toBeNull();
  });

  it('offers 桌面播放 on another dance while one loops', async () => {
    mount();
    await loopA();
    await click(document.querySelector('[data-mmd="mmd_b"] button[aria-pressed]')!);
    expect(detail().getAttribute('data-mmd-detail')).toBe('mmd_b');
    expect(desk('停止')).toBeNull();
    expect(desk('桌面播放')).not.toBeNull();
  });

  it('greys 停止 with the same reason as 桌面播放 while she switches', async () => {
    const m = mount();
    await loopA();
    m.rerender({ switching: true });
    expect(desk('停止')!.disabled).toBe(true);
    expect(desk('停止')!.title).toBe('角色正在切换');
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

describe('MMD · her list', () => {
  const IDS = ['mmd_a', 'mmd_b'];

  it('is not saved before it is read', async () => {
    const read = deferred<MotionPlaylist>();
    vi.spyOn(bridge.character, 'getPlaylist').mockReturnValue(read.promise);
    const set = vi.spyOn(bridge.character, 'setPlaylist');
    vi.spyOn(bridge.avatar, 'playlistState').mockResolvedValue({ playing: false, index: null, id: null });
    const { result } = renderHook(() => useSetlist('si', IDS, vi.fn()));
    act(() => result.current.put(['mmd_b']));
    expect(set).not.toHaveBeenCalled();
    await act(async () => read.resolve({ items: ['mmd_a'], loop: 'off', speed: 1 }));
    expect(result.current.items).toEqual(['mmd_a']);
    act(() => result.current.put(['mmd_a', 'mmd_b']));
    expect(set).toHaveBeenLastCalledWith({ items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 1 });
  });

  it('keeps a newer edit when an older save fails after it', async () => {
    vi.spyOn(bridge.character, 'getPlaylist').mockResolvedValue({ items: [], loop: 'off', speed: 1 });
    vi.spyOn(bridge.avatar, 'playlistState').mockResolvedValue({ playing: false, index: null, id: null });
    const first = deferred<{ ok: true }>();
    vi.spyOn(bridge.character, 'setPlaylist').mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true });
    const toast = vi.fn();
    const { result } = renderHook(() => useSetlist('si', IDS, toast));
    await act(async () => {});
    act(() => result.current.put(['mmd_a']));
    await act(async () => result.current.put(['mmd_a', 'mmd_b']));
    await act(async () => first.reject({ code: 'failed' }));
    expect(result.current.items).toEqual(['mmd_a', 'mmd_b']);
    expect(toast).toHaveBeenCalledWith('改 MMD 列表没有完成：桌面角色没有回应', { severity: 'danger' });
  });
});
