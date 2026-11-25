// Review 11-22 (3b1a#7, #8): the MMD page's desktop loop belongs to her and that dance; her list is not edited before it is read, and only the latest save rolls back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, AvatarAction, MmdEntry, MotionPlaylist } from '../../src/bridge/protocol';
import { MmdPage } from '../../src/pages/mmd/Page';
import { useSetlist } from '../../src/pages/mmd/useSetlist';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

type Runtime = Awaited<ReturnType<AgenticComplexBridge['app']['runtime']>>;

const baked = (id: string, title: string): MmdEntry => ({
  id, title, durationS: 10, hasBgm: false, hasCamera: false, hasFace: false, project: null, role: null, createdAt: '',
  characters: ['si', 'voice_a'].map((c) => ({ id: c, state: 'baked' as const, reason: null })),
});
const ACTIONS: AvatarAction[] = [
  { id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 10, playable: true },
  { id: 'mmd_b', label: '舞蹈乙', enabled: true, section: 'idle', durationS: 10, playable: true },
];

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [baked('mmd_a', '舞蹈甲'), baked('mmd_b', '舞蹈乙')] });
  vi.spyOn(bridge.avatar, 'actions').mockResolvedValue(ACTIONS);
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

/** The MMD page; `runtime` sends a new runtime snapshot (her process, the switch, the current character). */
async function mount() {
  let send: (s: Runtime) => void = () => {};
  vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
    send = cb;
    return () => {};
  });
  const rt = await bridge.app.runtime();
  const root = createRootRoute({ component: MmdPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: 'MMD 库' });
  return {
    runtime: (over: { avatar?: Runtime['processes']['avatar']['state']; switching?: boolean; current?: string } = {}) =>
      act(async () =>
        send({
          ...rt,
          character: { ...rt.character, switching: over.switching ?? false, ...(over.current ? { current: over.current, shown: over.current, agentd: over.current } : {}) },
          processes: { ...rt.processes, avatar: { ...rt.processes.avatar, state: over.avatar ?? 'running' } },
        }),
      ),
  };
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
const timeline = () => screen.getByRole('region', { name: '时间线' });
const desk = (name: '桌面播放' | '停止桌面播放') => within(timeline()).queryByRole('button', { name }) as HTMLButtonElement | null;

/** Loops mmd_a on the desktop, as 循环 then 桌面播放 do. */
async function loopA() {
  await waitFor(() => expect(document.querySelector('[data-mmd="mmd_a"]')).not.toBeNull());
  await click(within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name: '循环' }));
  await click(desk('桌面播放')!);
  await waitFor(() => expect(desk('停止桌面播放')).not.toBeNull());
}

describe('MMD · 停止桌面播放 belongs to the loop it stops', () => {
  it('drops 停止桌面播放 when the avatar goes offline, and does not bring it back when she runs again', async () => {
    const m = await mount();
    await loopA();
    await m.runtime({ avatar: 'stopped' });
    expect(desk('停止桌面播放')).toBeNull();
    expect(desk('桌面播放')!.disabled).toBe(true);
    await m.runtime();
    expect(desk('停止桌面播放')).toBeNull();
  });

  it('drops 停止桌面播放 after a switch to another character', async () => {
    const m = await mount();
    await loopA();
    await m.runtime({ current: 'voice_a' });
    await waitFor(() => expect(screen.getByRole('region', { name: '这支舞' }).getAttribute('data-mmd-detail')).toBe('mmd_a'));
    expect(desk('停止桌面播放')).toBeNull();
    expect(desk('桌面播放')).not.toBeNull();
  });

  it('offers 桌面播放 on another dance while one loops', async () => {
    await mount();
    await loopA();
    await click(document.querySelector('[data-mmd="mmd_b"] button[aria-pressed]')!);
    expect(screen.getByRole('region', { name: '这支舞' }).getAttribute('data-mmd-detail')).toBe('mmd_b');
    expect(desk('停止桌面播放')).toBeNull();
    expect(desk('桌面播放')).not.toBeNull();
  });

  it('greys 停止桌面播放 with the same reason as 桌面播放 while she switches, and 导入 MMD with it', async () => {
    const m = await mount();
    await loopA();
    await m.runtime({ switching: true });
    expect(desk('停止桌面播放')!.disabled).toBe(true);
    expect(desk('停止桌面播放')!.title).toBe('角色正在切换');
    expect((screen.getByRole('button', { name: '导入 MMD' }) as HTMLButtonElement).disabled).toBe(true);
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
    expect(set).toHaveBeenLastCalledWith('si', { items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 1 });
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
