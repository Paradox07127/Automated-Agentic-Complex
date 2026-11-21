import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { DesktopCommand, DesktopState, AgenticComplexBridge } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { CmdRoot } from '../../src/surfaces/desktop/CmdRoot';
import { pendingCount, ringItems, type CmdItem } from '../../src/surfaces/desktop/cmd/actions';
import { ECHO_MS } from '../../src/surfaces/desktop/cmd/input/QuickInput';
import { CommandRing } from '../../src/surfaces/desktop/cmd/ring/CommandRing';
import { runCmdAction } from '../../src/surfaces/desktop/cmd/ring/run';
import { stubMatchMedia } from './mediaStub';

// The command ring and its action table on `stack.html#/cmd`, and 快速输入, which moved under the bubble
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
  avatarHovered: false,
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

const item = (id: CmdItem['id'], s: DesktopState | null = STATE): CmdItem => {
  const found = ringItems(s).find((i) => i.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

describe('the action table', () => {
  it('has the 8 direct items in key order', () => {
    expect(ringItems(STATE).map((i) => i.label)).toEqual(['快速输入', '屏幕识读', '待处理', '打开对话', '免打扰 30 分', '让鼠标穿过她', '隐藏 30 分', '送礼物']);
    expect(ringItems(STATE).map((i) => i.sub ?? null)).toEqual([null, null, null, null, null, null, null, '看她收礼']);
    expect(ringItems(STATE).map((i) => i.id)).toEqual(['input', 'look', 'openStack', 'goChat', 'quiet', 'pass', 'hide', 'gift']);
  });

  it('toggle labels follow the desktop state', () => {
    const now = 1_800_000_000_000;
    const on = ringItems({ ...STATE, hidden: true, clickThroughAll: true, quietUntil: now + 60_000 }, now);
    expect(on.map((i) => i.label).slice(4, 7)).toEqual(['结束免打扰', '结束点穿', '显示角色']);
    expect(on.map((i) => i.id).slice(4, 7)).toEqual(['quietEnd', 'pass', 'show']);
    expect(ringItems({ ...STATE, quietUntil: now - 60_000 }, now)[4]?.id).toBe('quiet');
  });

  it('counts questions, approvals and results in presence, past the first 3', () => {
    expect(pendingCount({ pending: { questions: [{}], questions_more: 0, approvals: [{}, {}, {}], approvals_more: 2, results: [], tasks: [{}] } })).toBe(6);
    expect(pendingCount(null)).toBe(0);
  });
});

describe('the ring', () => {
  it('the cmd preview shows it', async () => {
    stackBridge();
    mount('#/cmd?still=1');
    await screen.findByRole('menu', { name: '指令环' });
  });

  it('shows 8 items and hints the saved keys only', () => {
    render(<CommandRing items={ringItems(STATE)} pending={0} keys={{ hk_hide: '⌃H' }} onRun={() => {}} onClose={() => {}} />);
    const ring = screen.getByRole('menu', { name: '指令环' });
    expect(within(ring).getAllByRole('menuitem')).toHaveLength(8);
    expect(within(ring).getByRole('menuitem', { name: /^隐藏 30 分/ }).textContent).toContain('⌃H');
    expect(within(ring).getByRole('menuitem', { name: /^送礼物/ }).textContent).toContain('看她收礼');
    expect(ring.textContent).not.toMatch(/⌃⌥|默认/);
    expect(ring.textContent).toContain('1–8 直接执行 │ esc 关闭');
  });

  it('with 7 items the arrows wrap over 7 and the hint says 1–7', () => {
    const onRun = vi.fn();
    const items = ringItems(STATE).slice(0, 7);
    render(<CommandRing items={items} pending={0} onRun={onRun} onClose={() => {}} />);
    const ring = screen.getByRole('menu', { name: '指令环' });
    fireEvent.keyDown(ring, { key: 'ArrowRight' });
    fireEvent.keyDown(ring, { key: 'ArrowLeft' });
    fireEvent.keyDown(ring, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledWith(items[6]);
    expect(ring.textContent).toContain('1–7 直接执行 │ esc 关闭');
  });

  it('1–8 run their item directly, hover opens nothing, esc closes, and 待处理 shows its count', () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandRing items={ringItems(STATE)} pending={4} onRun={onRun} onClose={onClose} />);
    const ring = screen.getByRole('menu', { name: '指令环' });
    expect(within(ring).getByRole('menuitem', { name: /待处理/ }).textContent).toContain('4');
    for (const el of within(ring).getAllByRole('menuitem')) fireEvent.mouseEnter(el);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.keyDown(ring, { key: '3' });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'openStack' }));
    fireEvent.keyDown(ring, { key: '6' });
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pass' }));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.keyDown(ring, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it('pressing 3 on the opened ring opens the stack once and closes the panel', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action');
    const close = vi.spyOn(bridge.window, 'close');
    mount('#/cmd?still=1&plugins=screen_reading');
    await screen.findByRole('menu', { name: '指令环' });
    await flush(async () => {});
    await flush(async () => fireEvent.keyDown(screen.getByRole('menu', { name: '指令环' }), { key: '3' }));
    expect(action.mock.calls).toEqual([['openStack']]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu', { name: '指令环' })).toBeNull();
  });
});

describe('ring actions', () => {
  const ctx = (bridge: AgenticComplexBridge, state: DesktopState | null = STATE, now = 1_800_000_000_000) => ({ bridge, state, now: () => now });

  it('免打扰 starts and ends through native, asking agentd nothing', async () => {
    const bridge = stackBridge();
    const request = vi.spyOn(bridge.agentd, 'request');
    const action = vi.spyOn(bridge.desktop, 'action');
    const now = 1_800_000_000_000;
    expect(await runCmdAction(item('quiet'), ctx(bridge, STATE, now))).toMatchObject({ kind: 'receipt', tone: 'success', text: expect.stringContaining('免打扰已开始') });
    const quiet = { ...STATE, quietUntil: now + 60_000 };
    const end = ringItems(quiet, now)[4];
    expect(end && (await runCmdAction(end, ctx(bridge, quiet, now)))).toMatchObject({ kind: 'receipt', text: '免打扰已结束' });
    expect(action.mock.calls.map((c) => c[0])).toEqual(['quiet', 'quietEnd']);
    expect(request).not.toHaveBeenCalled();
  });

  it('the hide and pass receipts name the saved key, or none', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action');
    const texts = async (hotkeys: Record<string, string>) => {
      const s = { ...STATE, hotkeys };
      const out = await Promise.all([runCmdAction(item('hide', s), ctx(bridge, s)), runCmdAction(item('pass', s), ctx(bridge, s))]);
      return out.map((o) => (o.kind === 'receipt' ? o.text : ''));
    };
    const [hide, pass] = await texts({ hk_hide: '⌃H', hk_pass: '⌃P' });
    expect(hide).toContain('⌃H 显示');
    expect(pass).toContain('⌃P 关闭');
    expect((await texts({})).join(' ')).not.toMatch(/⌃/);
    expect(action.mock.calls.map((c) => c[0])).toEqual(['hide', 'clickThroughAll', 'hide', 'clickThroughAll']);
  });

  it('送礼物 goes to native and asks agentd nothing', async () => {
    const bridge = stackBridge();
    const request = vi.spyOn(bridge.agentd, 'request');
    const action = vi.spyOn(bridge.desktop, 'action');
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    const out = await runCmdAction(item('gift'), ctx(bridge));
    expect(action).toHaveBeenCalledWith('gift');
    expect(request).not.toHaveBeenCalled();
    expect(openMain).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'receipt', text: '已送出礼物' });
  });

  it('a gift native could not play shows its reason, not 已送出礼物', async () => {
    const bridge = stackBridge();
    vi.spyOn(bridge.desktop, 'action').mockRejectedValue({ code: 'failed', detail: '当前角色包尚未导入原作收礼动作' });
    const out = await runCmdAction(item('gift'), ctx(bridge));
    expect(out).toMatchObject({ kind: 'receipt', tone: 'danger', text: expect.stringContaining('当前角色包尚未导入原作收礼动作') });
    expect(out.kind === 'receipt' && out.text).not.toContain('已送出礼物');
  });

  it('打开对话 opens the chat page in the main window', async () => {
    const bridge = stackBridge();
    const openMain = vi.spyOn(bridge.window, 'openMain').mockImplementation(() => {});
    expect(await runCmdAction(item('goChat'), ctx(bridge))).toEqual({ kind: 'close' });
    expect(openMain).toHaveBeenCalledWith(expect.stringMatching(/^\/chat/));
  });

  it('快速输入 on the ring asks native for the bubble’s input and closes the ring', async () => {
    const bridge = stackBridge();
    const action = vi.spyOn(bridge.desktop, 'action');
    const close = vi.spyOn(bridge.window, 'close');
    mount('#/cmd?mode=ring&still=1');
    await screen.findByRole('menu', { name: '指令环' });
    await flush(async () => {});
    const ring = screen.getByRole('menu', { name: '指令环' });
    await flush(async () => fireEvent.click(within(ring).getByRole('menuitem', { name: /^快速输入/ })));
    expect(action.mock.calls).toEqual([['quickInput']]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu', { name: '指令环' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
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
    flush(() => send({ kind: 'open', mode: 'tune' }));
    flush(() => visible(true));
    expect(root?.childElementCount).toBe(1);
    flush(() => visible(false));
    expect(root?.childElementCount).toBe(0);
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
