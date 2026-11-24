import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopCommand, DesktopState, AgenticComplexBridge } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { CmdRoot } from '../../src/surfaces/desktop/CmdRoot';
import type { AvatarAction } from '../../src/bridge';
import { actionItems, giftOff, pendingCount, poseItems, wheelItems, type CmdItem } from '../../src/surfaces/desktop/cmd/actions';
import { ECHO_MS } from '../../src/surfaces/desktop/cmd/input/QuickInput';
import { CommandRing } from '../../src/surfaces/desktop/cmd/ring/CommandRing';
import { runCmdAction, type RunItem } from '../../src/surfaces/desktop/cmd/ring/run';
import { stubMatchMedia } from './mediaStub';

// Her wheel and its action table on `stack.html#/cmd`, and 快速输入, which moved under the bubble
// (`#/bubble`); also the stack wheel and in-place input assertions taken off the stack page (stack-role-cards,
// stack-reminders and cross-page-reads), moved here.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

function stackBridge(): AgenticComplexBridge {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  return bridge;
}

function mount(hash: string) {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {hash.startsWith('#/bubble') ? <BubbleRoot /> : <CmdRoot />}
    </QueryClientProvider>,
  );
}

const STATE: DesktopState = {
  hidden: false,
  clickThroughAll: false,
  freeRoam: false,
  quietUntil: null,
  dock: { open: false, side: 'right', compact: false },
  character: { id: 'voice_a', name: '示例甲' },
  characters: [
    { id: 'voice_a', name: '示例甲' },
    { id: 'cedar', name: '示例丙' },
  ],
  screens: [{ id: '1', name: '内建显示器', current: true }],
  hotkeys: {},
  pips: { agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 }, voice: 'on' },
  computerUseActive: false,
  plugins: ['light_ai', 'screen_reading'],
};

/** A slot that runs, as RingSlot hands it on; 动作 and 姿态 open a level instead. */
const runs = (i: CmdItem | null | undefined): RunItem => {
  if (!i || i.id === 'actions' || i.id === 'poses') throw new Error(`${i?.id ?? 'an empty slot'} does not run`);
  return { ...i, id: i.id };
};

const item = (id: CmdItem['id'], s: DesktopState | null = STATE, pending = 2): RunItem =>
  runs([...wheelItems(s, pending), ...actionItems(s, [], [])].find((i) => i?.id === id));

const dance = (id: string, label: string, durationS = 252): AvatarAction => ({ id, label, enabled: true, section: 'mmd', durationS, playable: true });
const DANCES: AvatarAction[] = [
  { id: 'receive_gift', label: '收礼', enabled: true },
  dance('mmd_jile', '极乐净土'),
  dance('mmd_love', '恋爱循环（完整版）', 252),
  dance('mmd_lamb', 'Lamb.'),
  dance('mmd_hibana', 'ヒバナ'),
  dance('mmd_e', '舞五'),
  dance('mmd_f', '舞六'),
  dance('mmd_g', '舞七'),
];
const POSES: NonNullable<DesktopState['poses']> = {
  slots: [
    { title: '站', id: 'pose_stand', reason: null },
    { title: '叉腰', id: 'pose_akimbo', reason: null },
    { title: '坐', id: 'pose_sit', reason: null },
    { title: '坐地', id: 'pose_floor', reason: null },
    { title: '躺', id: null, reason: '这个角色没有这个姿态的原作动作' },
  ],
  current: 'pose_sit',
};

describe('the action table', () => {
  it('has the 8 slots of the design, clockwise from the top', () => {
    expect(wheelItems(STATE, 2).map((i) => i.label)).toEqual(['对话页', '待处理', '免打扰', '点穿', '放回原位', '自由活动', '动作', '角色页']);
    expect(wheelItems(STATE, 2).map((i) => i.id)).toEqual(['goChat', 'pending', 'quiet', 'pass', 'home', 'roam', 'actions', 'goCharacter']);
    expect(wheelItems(STATE, 2)[1]).toMatchObject({ count: 2 });
  });

  it('07 is 动作, opening a level, while nothing plays, and 停止 naming the play while she plays', () => {
    const now = 1_800_000_000_000;
    expect(wheelItems(STATE, 0, now, DANCES)[6]).toMatchObject({ id: 'actions', label: '动作', icon: 'play', deeper: true });
    expect(wheelItems({ ...STATE, playing: null }, 0, now, DANCES)[6]?.id).toBe('actions');
    const stop = wheelItems({ ...STATE, playing: 'mmd_lamb' }, 0, now, DANCES)[6];
    expect(stop).toMatchObject({ id: 'stop', label: '停止', icon: 'stop', on: true, desc: 'Lamb.' });
    expect(stop?.deeper).toBeUndefined();
    // A play her list does not name is named by its id.
    expect(wheelItems({ ...STATE, playing: 'chain_x' }, 0, now, DANCES)[6]).toMatchObject({ id: 'stop', desc: 'chain_x' });
  });

  it('动作\'s level: the first 6 dances of her setlist in its order, 姿态 at 07 and 送礼物 at 08 in place, fewer dances leave holes', () => {
    const setlist = ['mmd_love', 'mmd_gone', 'mmd_jile', 'mmd_lamb', 'mmd_hibana', 'mmd_e', 'mmd_f', 'mmd_g'];
    const level = actionItems({ ...STATE, poses: POSES, playing: 'mmd_lamb' }, setlist, DANCES);
    expect(level.map((i) => i?.label ?? null)).toEqual(['恋爱循环（完整版）', '极乐净土', 'Lamb.', 'ヒバナ', '舞五', '舞六', '姿态', '送礼物']);
    // Each plays the list on from its own place in the saved list, past the id she no longer has.
    expect(level.slice(0, 6).map((i) => i?.start)).toEqual([0, 2, 3, 4, 5, 6]);
    expect(level[0]).toMatchObject({ id: 'dance', icon: 'play', desc: '04:12' });
    expect(level.map((i) => i?.on ?? false)).toEqual([false, false, true, false, false, false, false, false]);
    expect(level[6]).toMatchObject({ id: 'poses', deeper: true });
    expect(level[6]?.off).toBeUndefined();
    const short = actionItems(STATE, ['mmd_jile', 'mmd_lamb'], DANCES);
    expect(short.map((i) => i?.id ?? null)).toEqual(['dance', 'dance', null, null, null, null, 'poses', 'gift']);
  });

  it('姿态\'s level: 自动 and her poses; the held one is marked, one she lacks is off with why; no poses greys 姿态', () => {
    const level = poseItems({ ...STATE, poses: POSES });
    expect(level.map((i) => i?.label)).toEqual(['自动', '站', '叉腰', '坐', '坐地', '躺']);
    expect(level.map((i) => i?.pose)).toEqual([null, 'pose_stand', 'pose_akimbo', 'pose_sit', 'pose_floor', null]);
    expect(level.map((i) => i?.on ?? false)).toEqual([false, false, false, true, false, false]);
    expect(level[5]).toMatchObject({ id: 'pose', off: '这个角色没有这个姿态的原作动作' });
    expect(poseItems({ ...STATE, poses: { ...POSES, current: null } })[0]?.on).toBe(true);
    // A renderer without `poses` (Windows today) sends none.
    for (const s of [STATE, { ...STATE, poses: null }]) expect(actionItems(s, [], DANCES)[6]).toMatchObject({ id: 'poses', off: '这个版本的角色不支持姿态' });
  });

  it('待处理 with nothing waiting is greyed with its reason; the toggles follow the desktop state', () => {
    const now = 1_800_000_000_000;
    expect(wheelItems(STATE, 0, now)[1]).toMatchObject({ id: 'pending', off: '没有待处理的事' });
    const on = wheelItems({ ...STATE, freeRoam: true, quietUntil: now + 60_000, hotkeys: { hk_pass: '⌃P' } }, 0, now);
    expect(on[2]).toMatchObject({ id: 'quietEnd', label: '结束免打扰', on: true });
    expect(on[5]).toMatchObject({ id: 'roam', on: true });
    expect(on[3]?.desc).toContain('⌃P 恢复');
    expect(wheelItems({ ...STATE, quietUntil: now - 60_000 }, 0, now)[2]?.id).toBe('quiet');
  });

  it('送礼物 is greyed with why when her package has no gift action, or has it missing', () => {
    expect(giftOff([{ id: 'receive_gift', label: '收礼', enabled: true }])).toBeNull();
    expect(giftOff([{ id: 'wave', label: '挥手', enabled: true }])).toBe('当前角色包尚未导入原作收礼动作');
    expect(giftOff([{ id: 'interact_receive_gift', label: '收礼', enabled: true, missing: true, missingReason: '缺动作文件' }])).toBe('缺动作文件');
    expect(actionItems(STATE, [], DANCES, '缺动作文件')[7]).toMatchObject({ id: 'gift', label: '送礼物', off: '缺动作文件' });
    expect(actionItems(STATE, [], DANCES)[7]?.off).toBeUndefined();
  });

  it('counts questions, approvals and results in presence, past the first 3', () => {
    expect(pendingCount({ pending: { questions: [{}], questions_more: 0, approvals: [{}, {}, {}], approvals_more: 2, results: [], tasks: [{}] } })).toBe(6);
    expect(pendingCount(null)).toBe(0);
  });
});

describe('the wheel', () => {
  const center = { en: 'AGENTIC COMPLEX', name: '示例甲', desc: '待命' };

  it('the cmd preview shows it', async () => {
    stackBridge();
    mount('#/cmd?still=1');
    await screen.findByRole('menu', { name: '角色的轮盘' });
  });

  it('shows 8 slots with their names, one level, and the key help only while ⌘ is held', () => {
    render(<CommandRing items={wheelItems(STATE, 3)} center={center} onRun={() => {}} onClose={() => {}} />);
    const wheel = screen.getByRole('menu', { name: '角色的轮盘' });
    expect(within(wheel).getAllByRole('menuitem')).toHaveLength(8);
    expect(within(wheel).getByRole('menuitem', { name: '2 待处理 3' })).toBeTruthy();
    expect(wheel.textContent).toContain('示例甲');
    expect(wheel.closest('[data-keys]')).toBeNull();
    flush(() => void fireEvent.keyDown(window, { key: 'Meta', metaKey: true }));
    expect(wheel.closest('[data-keys]')).not.toBeNull();
    flush(() => void fireEvent.keyUp(window, { key: 'Meta' }));
    expect(wheel.closest('[data-keys]')).toBeNull();
  });

  it('1–8 run their slot directly, a greyed slot does not run, esc closes', () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandRing items={wheelItems(STATE, 0)} center={center} onRun={onRun} onClose={onClose} />);
    const wheel = screen.getByRole('menu', { name: '角色的轮盘' });
    fireEvent.keyDown(wheel, { key: '2' });
    expect(onRun).not.toHaveBeenCalled();
    expect(wheel.textContent).toContain('没有待处理的事');
    fireEvent.keyDown(wheel, { key: '4' });
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pass' }));
    fireEvent.keyDown(wheel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opened by a right click it centres on the click; the hot key\'s sits in the middle of its box', () => {
    const at = render(<CommandRing items={wheelItems(STATE, 0)} center={center} at={{ x: 300, y: 250 }} onRun={() => {}} onClose={() => {}} />);
    const placed = at.container.querySelector<HTMLElement>('[data-stub="GameWheel"]');
    expect([placed?.style.left, placed?.style.top]).toEqual(['40px', '-10px']);
    at.unmount();
    render(<CommandRing items={wheelItems(STATE, 0)} center={center} onRun={() => {}} onClose={() => {}} />);
    expect(document.querySelector<HTMLElement>('[data-stub="GameWheel"]')?.style.left).toBe('');
  });

  it('a level under the first draws no empty slot; its centre, Esc and Backspace go back up; the first level\'s Esc closes', () => {
    const onRun = vi.fn();
    const onBack = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <CommandRing items={actionItems(STATE, ['mmd_jile'], DANCES)} center={{ en: '07', name: '动作', desc: '' }} level="actions" onBack={onBack} onRun={onRun} onClose={onClose} />,
    );
    const wheel = screen.getByRole('menu', { name: '角色的轮盘' });
    expect(within(wheel).getAllByRole('menuitem').map((m) => m.getAttribute('aria-label'))).toEqual(['1 极乐净土', '7 姿态', '8 送礼物']);
    fireEvent.keyDown(wheel, { key: '3' });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.keyDown(wheel, { key: 'Escape' });
    fireEvent.keyDown(wheel, { key: 'Backspace' });
    // jsdom lays nothing out: the centre is at 0,0.
    fireEvent.pointerDown(window, { button: 0, clientX: 0, clientY: 0 });
    expect(onBack).toHaveBeenCalledTimes(3);
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
    render(<CommandRing items={wheelItems(STATE, 0)} center={center} onRun={onRun} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('menu', { name: '角色的轮盘' }), { key: 'Backspace' });
    fireEvent.keyDown(screen.getByRole('menu', { name: '角色的轮盘' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a held press resting 300 ms on a slot that opens a level runs it once; resting on into the next level opens nothing more', async () => {
    const onRun = vi.fn();
    const rest = (ms: number) => flush(() => new Promise((r) => setTimeout(r, ms)));
    const props = { center, onClose: () => {}, onRun };
    const level1 = wheelItems(STATE, 0);
    const view = render(<CommandRing {...props} items={level1} press={{ phase: 'move', x: -100, y: 0 }} />);
    await rest(200);
    expect(onRun).not.toHaveBeenCalled();
    await rest(150);
    expect(onRun.mock.calls.map((c) => c[0].id)).toEqual(['actions']);
    // The pointer is still on 07, now 姿态, a slot that opens a level too.
    const level2 = actionItems({ ...STATE, poses: POSES }, ['mmd_jile'], DANCES);
    view.rerender(<CommandRing {...props} items={level2} level="actions" press={{ phase: 'move', x: -101, y: 1 }} />);
    await rest(400);
    expect(onRun).toHaveBeenCalledTimes(1);
    view.rerender(<CommandRing {...props} items={level2} level="actions" press={{ phase: 'move', x: 0, y: -100 }} />);
    view.rerender(<CommandRing {...props} items={level2} level="actions" press={{ phase: 'move', x: -100, y: 0 }} />);
    await rest(350);
    expect(onRun.mock.calls.map((c) => c[0].id)).toEqual(['actions', 'poses']);
  });

  it('a release still on the slot whose rest opened the level picks nothing there; the pointer must leave it first', async () => {
    const onRun = vi.fn();
    const rest = (ms: number) => flush(() => new Promise((r) => setTimeout(r, ms)));
    const props = { center, onClose: () => {}, onRun };
    const view = render(<CommandRing {...props} items={wheelItems(STATE, 0)} press={{ phase: 'move', x: -100, y: 0 }} />);
    await rest(350);
    const level2 = actionItems({ ...STATE, poses: POSES }, ['mmd_jile'], DANCES);
    view.rerender(<CommandRing {...props} items={level2} level="actions" press={{ phase: 'move', x: -100, y: 0 }} />);
    view.rerender(<CommandRing {...props} items={level2} level="actions" press={{ phase: 'up', x: -100, y: 0, ms: 900 }} />);
    expect(onRun.mock.calls.map((c) => c[0].id)).toEqual(['actions']);
    expect(screen.getByRole('menu', { name: '角色的轮盘' })).toBeTruthy();
  });

  it('a rest armed before Esc goes back up opens nothing once the wait ends', async () => {
    const onRun = vi.fn();
    const rest = (ms: number) => flush(() => new Promise((r) => setTimeout(r, ms)));
    const level2 = actionItems({ ...STATE, poses: POSES }, ['mmd_jile'], DANCES);
    const props = { center, onClose: () => {}, onRun };
    const press = { phase: 'move', x: -100, y: 0 } as const;
    const view = render(<CommandRing {...props} items={level2} level="actions" onBack={() => {}} press={press} />);
    await rest(100);
    fireEvent.keyDown(screen.getByRole('menu', { name: '角色的轮盘' }), { key: 'Escape' });
    view.rerender(<CommandRing {...props} items={wheelItems(STATE, 0)} press={press} />);
    await rest(350);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('Enter on a slot that opened a level does not run the slot in its place on the new level; held keys do not repeat', () => {
    const onRun = vi.fn();
    const props = { center, onClose: () => {}, onRun };
    const view = render(<CommandRing {...props} items={wheelItems(STATE, 0)} />);
    const wheel = () => screen.getByRole('menu', { name: '角色的轮盘' });
    fireEvent.keyDown(wheel(), { key: '4', repeat: true });
    fireEvent.keyDown(wheel(), { key: 'ArrowLeft' });
    fireEvent.keyDown(wheel(), { key: 'ArrowLeft' });
    fireEvent.keyDown(wheel(), { key: 'Enter' });
    expect(onRun.mock.calls.map((c) => c[0].id)).toEqual(['actions']);
    view.rerender(<CommandRing {...props} items={actionItems({ ...STATE, poses: POSES }, ['mmd_jile'], DANCES)} level="actions" />);
    fireEvent.keyDown(wheel(), { key: 'Enter', repeat: true });
    fireEvent.keyDown(wheel(), { key: 'Enter' });
    expect(onRun.mock.calls.map((c) => c[0].id)).toEqual(['actions']);
  });

  it('on Windows the key help shows while Ctrl is held, not the Windows key', () => {
    window.agenticComplex = { ...createFakeBridge({ surface: 'stack', still: true }), platform: 'windows' };
    render(<CommandRing items={wheelItems(STATE, 0)} center={center} onRun={() => {}} onClose={() => {}} />);
    const wheel = screen.getByRole('menu', { name: '角色的轮盘' });
    flush(() => void fireEvent.keyDown(window, { key: 'Meta', metaKey: true }));
    expect(wheel.closest('[data-keys]')).toBeNull();
    flush(() => void fireEvent.keyDown(window, { key: 'Control', ctrlKey: true }));
    expect(wheel.closest('[data-keys]')).not.toBeNull();
    flush(() => void fireEvent.keyUp(window, { key: 'Control' }));
    expect(wheel.closest('[data-keys]')).toBeNull();
  });

  it('the desktop panels may read her setlist and play it from a dance', async () => {
    const bridge = stackBridge();
    await expect(bridge.character.getPlaylist()).resolves.toEqual({ items: [], loop: 'off', speed: 1 });
    await expect(bridge.avatar.playPlaylist({ start: 0 })).resolves.toEqual({ ok: false, reason: 'empty' });
  });

  it('7 opens 动作 in place with her setlist; Esc goes back up; a dance plays her list from it and closes the panel', async () => {
    const bridge = stackBridge();
    vi.spyOn(bridge.avatar, 'actions').mockResolvedValue(DANCES);
    vi.spyOn(bridge.character, 'getPlaylist').mockResolvedValue({ items: ['mmd_lamb', 'mmd_jile'], loop: 'one', speed: 1 });
    const play = vi.spyOn(bridge.avatar, 'playPlaylist').mockResolvedValue({ ok: true });
    const close = vi.spyOn(bridge.window, 'close');
    mount('#/cmd?still=1');
    await screen.findByRole('menu', { name: '角色的轮盘' });
    await flush(async () => {});
    const wheel = screen.getByRole('menu', { name: '角色的轮盘' });
    await flush(async () => fireEvent.keyDown(wheel, { key: '7' }));
    expect(within(wheel).getAllByRole('menuitem').map((m) => m.getAttribute('aria-label'))).toEqual(['1 Lamb.', '2 极乐净土', '7 姿态', '8 送礼物']);
    expect(wheel.textContent).toContain('动作');
    await flush(async () => fireEvent.keyDown(wheel, { key: 'Escape' }));
    expect(within(wheel).getByRole('menuitem', { name: '7 动作' })).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    await flush(async () => fireEvent.keyDown(wheel, { key: '7' }));
    await flush(async () => fireEvent.keyDown(wheel, { key: '2' }));
    expect(play).toHaveBeenCalledWith({ start: 1 });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('the fake sends the opening command once, like native, so a page subscribing later gets none', async () => {
    window.location.hash = '#/cmd?still=1';
    const bridge = stackBridge();
    const first: DesktopCommand[] = [];
    const later: DesktopCommand[] = [];
    bridge.desktop.onCommand((c) => first.push(c));
    await flush(async () => {});
    bridge.desktop.onCommand((c) => later.push(c));
    await flush(async () => {});
    expect(first).toEqual([{ kind: 'open', mode: 'ring' }]);
    expect(later).toEqual([]);
  });

  it('pressing 1 on the opened wheel opens the chat page once and closes the panel', async () => {
    const bridge = stackBridge();
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    const close = vi.spyOn(bridge.window, 'close');
    mount('#/cmd?still=1&at=300,250');
    await screen.findByRole('menu', { name: '角色的轮盘' });
    await flush(async () => {});
    await flush(async () => fireEvent.keyDown(screen.getByRole('menu', { name: '角色的轮盘' }), { key: '1' }));
    expect(openMain.mock.calls).toEqual([[expect.stringMatching(/^\/chat/)]]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu', { name: '角色的轮盘' })).toBeNull();
  });
});

describe('wheel actions', () => {
  const ctx = (bridge: AgenticComplexBridge, state: DesktopState | null = STATE, now = 1_800_000_000_000) => ({ bridge, state, now: () => now });

  it('免打扰 starts and ends through native, asking agentd nothing', async () => {
    const bridge = stackBridge();
    const request = vi.spyOn(bridge.agentd, 'request');
    const action = vi.spyOn(bridge.desktop, 'action');
    const now = 1_800_000_000_000;
    expect(await runCmdAction(item('quiet'), ctx(bridge, STATE, now))).toMatchObject({ kind: 'receipt', tone: 'success', text: expect.stringContaining('免打扰已开始') });
    const quiet = { ...STATE, quietUntil: now + 60_000 };
    const end = wheelItems(quiet, 0, now)[2];
    expect(await runCmdAction(runs(end), ctx(bridge, quiet, now))).toMatchObject({ kind: 'receipt', text: '免打扰已结束' });
    expect(action.mock.calls.map((c) => c[0])).toEqual(['quiet', 'quietEnd']);
    expect(request).not.toHaveBeenCalled();
  });

  it('点穿 names the saved key, or none; 放回原位 puts her and the panels back', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action');
    const pass = async (hotkeys: Record<string, string>) => {
      const s = { ...STATE, hotkeys };
      const o = await runCmdAction(item('pass', s), ctx(bridge, s));
      return o.kind === 'receipt' ? o.text : '';
    };
    expect(await pass({ hk_pass: '⌃P' })).toContain('⌃P 关闭');
    expect(await pass({})).not.toMatch(/⌃/);
    expect(await runCmdAction(item('home'), ctx(bridge))).toEqual({ kind: 'close' });
    expect(action.mock.calls.map((c) => c[0])).toEqual(['clickThroughAll', 'clickThroughAll', 'resetPosition', 'resetBoxes']);
  });

  it('送礼物 goes to native and asks agentd nothing; one native could not play shows its reason', async () => {
    const bridge = stackBridge();
    const request = vi.spyOn(bridge.agentd, 'request');
    const action = vi.spyOn(bridge.desktop, 'action');
    expect(await runCmdAction(item('gift'), ctx(bridge))).toEqual({ kind: 'close' });
    expect(action).toHaveBeenCalledWith('gift');
    expect(request).not.toHaveBeenCalled();
    action.mockRejectedValue({ code: 'failed', detail: '当前角色包尚未导入原作收礼动作' });
    expect(await runCmdAction(item('gift'), ctx(bridge))).toMatchObject({ kind: 'receipt', tone: 'danger', text: expect.stringContaining('当前角色包尚未导入原作收礼动作') });
  });

  it('对话页, 待处理 and 角色页 open the main window', async () => {
    const bridge = stackBridge();
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    for (const id of ['goChat', 'pending', 'goCharacter'] as const) expect(await runCmdAction(item(id), ctx(bridge))).toEqual({ kind: 'close' });
    expect(openMain.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/^\/chat/), expect.stringMatching(/^\/overview\?.*focus=pending/), expect.stringMatching(/^\/character/)]);
  });

  it('a layer the page closed itself is dropped when native hides the panel', () => {
    const bridge = stackBridge();
    let send: (c: DesktopCommand) => void = () => {};
    let visible: (v: boolean) => void = () => {};
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      send = cb;
      return () => {};
    });
    vi.spyOn(bridge.window, 'onVisibility').mockImplementation((cb) => {
      visible = cb;
      return () => {};
    });
    mount('#/cmd?still=1');
    const root = document.querySelector('[data-surface-root="cmd"]');
    flush(() => send({ kind: 'open', mode: 'ring' }));
    flush(() => visible(true));
    expect(root?.childElementCount).toBe(1);
    flush(() => visible(false));
    expect(root?.childElementCount).toBe(0);
  });

  it('C3 rule 56: the shell\'s ringPointer lights the slot under the held right button, and its release runs that slot', async () => {
    const bridge = stackBridge();
    const openMain = vi.spyOn(bridge.window, 'openMain');
    const listeners = new Set<(c: DesktopCommand) => void>();
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    });
    const push = (c: DesktopCommand) => flush(async () => listeners.forEach((cb) => cb(c)));
    mount('#/cmd?still=1');
    await push({ kind: 'open', mode: 'ring', at: { x: 260, y: 260 } });
    await screen.findByRole('menu', { name: '角色的轮盘' });
    // jsdom lays nothing out: the wheel's centre is at 0,0.
    await push({ kind: 'ringPointer', phase: 'move', x: 0, y: -80 });
    expect(document.querySelector('[role="menuitem"][data-sel]')?.getAttribute('aria-label')).toMatch(/^1 /);
    await push({ kind: 'ringPointer', phase: 'up', x: 0, y: -80, ms: 400 });
    await waitFor(() => expect(openMain).toHaveBeenCalledWith(expect.stringMatching(/^\/chat/)));
  });

  it('C3 rule 56: the held right button resting on 动作 opens its level, and its release on a dance plays it', async () => {
    const bridge = stackBridge();
    vi.spyOn(bridge.avatar, 'actions').mockResolvedValue(DANCES);
    vi.spyOn(bridge.character, 'getPlaylist').mockResolvedValue({ items: ['mmd_jile'], loop: 'off', speed: 1 });
    const play = vi.spyOn(bridge.avatar, 'playPlaylist').mockResolvedValue({ ok: true });
    const listeners = new Set<(c: DesktopCommand) => void>();
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    });
    const push = (c: DesktopCommand) => flush(async () => listeners.forEach((cb) => cb(c)));
    mount('#/cmd?still=1');
    await push({ kind: 'open', mode: 'ring', at: { x: 260, y: 260 } });
    await screen.findByRole('menu', { name: '角色的轮盘' });
    await push({ kind: 'ringPointer', phase: 'move', x: -100, y: 0 });
    await flush(() => new Promise((r) => setTimeout(r, 350)));
    expect(screen.getByRole('menuitem', { name: '1 极乐净土' })).toBeTruthy();
    await push({ kind: 'ringPointer', phase: 'move', x: 0, y: -100 });
    await push({ kind: 'ringPointer', phase: 'up', x: 0, y: -100, ms: 900 });
    expect(play).toHaveBeenCalledWith({ start: 0 });
  });

  it('a pick with a receipt hands it to her bubble through desktop.notice and closes the wheel, no toast on the panel', async () => {
    const bridge = stackBridge();
    const notice = vi.spyOn(bridge.desktop, 'notice');
    const close = vi.spyOn(bridge.window, 'close');
    mount('#/cmd?still=1');
    await screen.findByRole('menu', { name: '角色的轮盘' });
    await flush(async () => {});
    await flush(async () => fireEvent.keyDown(screen.getByRole('menu', { name: '角色的轮盘' }), { key: '3' }));
    await waitFor(() => expect(notice.mock.calls).toEqual([[expect.stringContaining('免打扰已开始')]]));
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('menu', { name: '角色的轮盘' })).toBeNull();
  });

  it('送礼物 under 动作 says why it cannot play, and 8 runs nothing', async () => {
    const bridge = stackBridge();
    vi.spyOn(bridge.avatar, 'actions').mockResolvedValue([{ id: 'wave', label: '挥手', enabled: true }]);
    const action = vi.spyOn(bridge.desktop, 'action');
    mount('#/cmd?still=1');
    await screen.findByRole('menu', { name: '角色的轮盘' });
    await flush(async () => {});
    const wheel = screen.getByRole('menu', { name: '角色的轮盘' });
    await flush(async () => fireEvent.keyDown(wheel, { key: '7' }));
    await waitFor(() => expect(within(wheel).getByRole('menuitem', { name: /^8 送礼物/ }).getAttribute('aria-disabled')).toBe('true'));
    await flush(async () => fireEvent.keyDown(wheel, { key: '8' }));
    expect(wheel.textContent).toContain('当前角色包尚未导入原作收礼动作');
    expect(action).not.toHaveBeenCalled();
  });

  it('停止 stops her play through native with a receipt; a dance plays her list from it; a pose goes to native, 自动 with none', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action');
    const play = vi.spyOn(bridge.avatar, 'playPlaylist');
    const playing = { ...STATE, playing: 'mmd_lamb' };
    const stop = wheelItems(playing, 0, Date.now(), DANCES)[6];
    expect(await runCmdAction(runs(stop), ctx(bridge, playing))).toEqual({ kind: 'receipt', tone: 'success', text: '动作已停止' });
    const [first] = actionItems(STATE, ['mmd_gone', 'mmd_jile'], DANCES);
    play.mockResolvedValueOnce({ ok: true });
    expect(await runCmdAction(runs(first), ctx(bridge))).toEqual({ kind: 'close' });
    expect(play).toHaveBeenCalledWith({ start: 1 });
    play.mockResolvedValueOnce({ ok: false, reason: 'not_started' });
    expect(await runCmdAction(runs(first), ctx(bridge))).toMatchObject({ kind: 'receipt', tone: 'danger', text: '极乐净土没有开始：角色没有接受' });
    const [auto, , , sit] = poseItems({ ...STATE, poses: POSES });
    expect(await runCmdAction(runs(sit), ctx(bridge))).toEqual({ kind: 'close' });
    expect(await runCmdAction(runs(auto), ctx(bridge))).toEqual({ kind: 'close' });
    expect(action.mock.calls).toEqual([['stopPlay'], ['pose', 'pose_sit'], ['pose', undefined]]);
  });

  it('an input open shows nothing on the cmd page', async () => {
    stackBridge();
    mount('#/cmd?mode=input&still=1');
    await flush(async () => {});
    await flush(async () => {});
    expect(document.querySelector('[data-surface-root="cmd"]')?.childElementCount).toBe(0);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('快速输入 under the bubble', () => {
  async function openInput(bridge: AgenticComplexBridge) {
    mount('#/bubble?mode=input&still=1');
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '你好' } });
    return box as HTMLTextAreaElement;
  }

  it('sends through desktop.say, never POST /say, and never reads /desktop/input', async () => {
    const bridge = stackBridge();
    const request = vi.spyOn(bridge.agentd, 'request');
    const say = vi.spyOn(bridge.desktop, 'say');
    const box = await openInput(bridge);
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({ text: '你好', attachWindow: false, noMemory: false, surface: 'quick_input' });
    expect((await screen.findByRole('status')).textContent).toBe('你：你好');
    const paths = request.mock.calls.map((c) => c[1]);
    expect(paths).not.toContain('/say');
    expect(paths.some((p) => p.startsWith('/desktop/input'))).toBe(false);
  });

  it('⏎ while an input method composes does not send', async () => {
    const bridge = stackBridge();
    const say = vi.spyOn(bridge.desktop, 'say');
    const box = await openInput(bridge);
    fireEvent.compositionStart(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(say).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledTimes(1);
  });

  it('the echo stays 2 s, then the input folds and native gets the key back', async () => {
    const bridge = stackBridge();
    const releaseKey = vi.spyOn(bridge.window, 'releaseKey');
    const box = await openInput(bridge);
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    await screen.findByText('你好');
    const shown = Date.now();
    expect(releaseKey).not.toHaveBeenCalled();
    await waitFor(() => expect(releaseKey).toHaveBeenCalledTimes(1), { timeout: ECHO_MS + 1500 });
    expect(Date.now() - shown).toBeGreaterThanOrEqual(ECHO_MS - 100);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a failed send keeps the text; agentd offers 重启后台服务', async () => {
    const bridge = stackBridge();
    vi.spyOn(bridge.desktop, 'say').mockResolvedValue({ ok: false, reason: 'agentd' });
    const restart = vi.spyOn(bridge.supervisor, 'restart').mockResolvedValue();
    const box = await openInput(bridge);
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect((await screen.findByRole('alert')).textContent).toContain('原文已保留');
    expect(box.value).toBe('你好');
    expect(screen.getByRole('dialog', { name: '快速输入' }).dataset.err).toBe('agentd');
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '重启后台服务' })));
    expect(restart).toHaveBeenCalledWith('agentd');
  });

  it('a kernel failure offers 重新检测, which sends the kept text again', async () => {
    const bridge = stackBridge();
    const say = vi.spyOn(bridge.desktop, 'say').mockResolvedValue({ ok: false, reason: 'kernel' });
    const box = await openInput(bridge);
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    await flush(async () => fireEvent.click(await screen.findByRole('button', { name: /重新检测/ })));
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenLastCalledWith({ text: '你好', attachWindow: false, noMemory: false, surface: 'quick_input' });
  });

  it('a draft kept by esc survives the input folding, and a sent line clears it', async () => {
    const bridge = stackBridge();
    const listeners = new Set<(c: DesktopCommand) => void>();
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    });
    const push = (c: DesktopCommand) => flush(async () => listeners.forEach((cb) => cb(c)));
    mount('#/bubble?mode=input&still=1');
    await push({ kind: 'open', mode: 'input' });
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: '没写完的话' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    await push({ kind: 'open', mode: 'input' });
    const again = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(again.value).toBe('没写完的话');
    await flush(async () => fireEvent.keyDown(again, { key: 'Enter' }));
    await screen.findByRole('status');
    await push({ kind: 'open', mode: 'input' });
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('');
  });

  it('a prefill alone does not send', async () => {
    const bridge = stackBridge();
    const say = vi.spyOn(bridge.desktop, 'say');
    vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
      queueMicrotask(() => cb({ kind: 'open', mode: 'input', prefill: '派发任务：' }));
      return () => {};
    });
    mount('#/bubble?mode=input&still=1');
    const box = (await screen.findByDisplayValue('派发任务：')) as HTMLTextAreaElement;
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(say).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '派发任务：整理周报' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: '派发任务：整理周报' }));
  });
});
