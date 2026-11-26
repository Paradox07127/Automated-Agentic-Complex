import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse, DesktopCommand, AgenticComplexBridge, StackPayload, StreamEvent } from '../../src/bridge/protocol';
import { navRoute } from '../../src/shell/nav';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { bubbleCards } from '../../src/surfaces/desktop/bubble/demo';
import { sayMs } from '../../src/surfaces/desktop/bubble/sayTime';
import { lingerMs } from '../../src/surfaces/desktop/comm/commReducer';
import { stubMatchMedia } from './mediaStub';

// The bubble beside her head (`#/bubble`): thought, her line, a due reminder, and 快速输入 under it, opened by a
// command or by a drop; each goes after its time. Which states draw no card is in status-chip.test.tsx.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = '';
});

const SAMPLED = 1_800_000_000;
const THOUGHT = { id: 't1', text: '测试又红了，像是同一个超时。', offer: '帮我看看', reply: '好，帮我看看', reason: 'error', at: SAMPLED, session_id: null };
const RUNNING = { state: 'running_tool', run_id: 'r1', since: SAMPLED - 4 * 60 - 5, doing: '在跑 swift test', intention: '我在跑测试。', activity: '执行工具' };

/** BubbleRoot on the fake bridge, with presence, cards, `/feed` and commands pushed by the test. */
function mountBubble(hash = '#/bubble') {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  window.location.hash = hash;
  let presence: ((raw: unknown) => void) | null = null;
  let cards: ((p: StackPayload) => void) | null = null;
  const feed = new Set<(e: StreamEvent) => void>();
  const commands = new Set<(c: DesktopCommand) => void>();
  vi.spyOn(bridge.desktop, 'onPresence').mockImplementation((cb) => {
    presence = cb;
    return () => {};
  });
  vi.spyOn(bridge.stack, 'onCards').mockImplementation((cb) => {
    cards = cb;
    return () => {};
  });
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation((cb) => {
    feed.add(cb);
    return () => feed.delete(cb);
  });
  vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
    commands.add(cb);
    return () => commands.delete(cb);
  });
  render(<BubbleRoot />);
  return {
    bridge,
    presence: (raw: unknown) => flush(async () => presence?.(raw)),
    cards: (list: StackPayload['cards']) => flush(async () => cards?.({ now: SAMPLED * 1000, cards: list, history: [] })),
    command: (c: DesktopCommand) => flush(async () => commands.forEach((cb) => cb(c))),
    line: (id: string, text: string, final = false, reason: unknown = null) =>
      flush(async () => {
        const data = JSON.stringify({ line_id: id, text_delta: text, final, cancelled: false, error: null, lane: 'character', reason });
        feed.forEach((cb) => cb({ event: 'line', id, data }));
      }),
    accepted: (id: string) =>
      flush(async () => {
        const data = JSON.stringify({ line_id: id, conversation_id: null, source: 'text', trace_id: `tr-${id}`, side: false });
        feed.forEach((cb) => cb({ event: 'turn_accepted', id, data }));
      }),
    /** Any `/feed` event; a `line` gets the fields `line` leaves at their defaults. */
    send: (event: string, data: Record<string, unknown> = {}) =>
      flush(async () => {
        const full = event === 'line' ? { text_delta: '', final: false, cancelled: false, error: null, lane: 'character', reason: null, ...data } : data;
        feed.forEach((cb) => cb({ event, id: String(full.line_id ?? event), data: JSON.stringify(full) }));
      }),
    /** Re-renders the bubble docked while she is hidden, so her lines show in the subtitle bar. */
    dock: () => {
      vi.spyOn(bridge.window, 'onAnchor').mockImplementation((cb) => {
        cb({ panel: 'bubble', state: 'docked', side: 'menubar', docked: 'hidden', far: false, toHead: null, room: { width: 400, height: 200 } });
        return () => {};
      });
      cleanup();
      render(<BubbleRoot />);
    },
  };
}

/** The text where it is shown, not in the last card kept fading for a moment after it went (`inert`). */
const said = (text: string) => screen.queryByText(text, { ignore: '[inert] *, script, style' });

const presenceOf = (extra: Record<string, unknown> = {}) => ({ sampled_at: SAMPLED, proactive_speech: true, thought: THOUGHT, role: RUNNING, ...extra });

describe('the bubble', () => {
  it('sends a typed reply once from the visible send button', async () => {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    await b.command({ kind: 'open', mode: 'input' });
    const dialog = screen.getByRole('dialog', { name: '快速输入' });
    const box = within(dialog).getByRole('textbox');
    const send = within(dialog).getByRole('button', { name: /发送消息/ });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(box, { target: { value: '把测试结果整理成三条' } });
    await flush(async () => {
      fireEvent.click(send);
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith({ text: '把测试结果整理成三条', attachWindow: false, noMemory: false, surface: 'quick_input' });
  });

  it('shows her latest thought, and its offer answers 好 through desktop.say', async () => {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    await b.presence(presenceOf());
    screen.getByText(THOUGHT.text);
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '帮我看看' })));
    expect(say).toHaveBeenCalledWith({
      text: '好，帮我看看',
      attachWindow: false,
      noMemory: false,
      surface: 'thought_offer',
      replyTo: { kind: 'thought', id: 't1' },
    });
    expect(document.querySelector('[data-surface-root="bubble"] [data-glass]')).not.toBeNull();
  });

  it('a finished line goes after its time, leaving no icon, and a new line shows the card', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf({ thought: null }));
    const text = '构建失败在第 42 行，补上分号再跑一次。';
    await b.line('l1', text);
    expect(document.querySelector('[data-bubble-timer]')).toBeNull();
    await b.line('l1', '', true);
    screen.getByText(text);
    expect(document.querySelector('[data-bubble-timer]')).not.toBeNull();
    await flush(async () => vi.advanceTimersByTime(lingerMs(text) - 300));
    screen.getByText(text);
    await flush(async () => vi.advanceTimersByTime(600));
    expect(said(text)).toBeNull();
    expect(screen.queryByRole('button', { name: '展开消息' })).toBeNull();
    await flush(async () => vi.advanceTimersByTime(500));
    expect(document.querySelector('[data-surface-root="bubble"] [data-region]')).toBeNull();

    await b.line('l2', '新的一句。', true);
    screen.getByText('新的一句。');
  });

  it('hover pauses the countdown and leaves at least 1500 ms after the pointer leaves', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf({ thought: null }));
    await b.line('l2', '好的。', true);
    const card = document.querySelector<HTMLElement>('[data-bubble]');
    if (!card) throw new Error('no bubble');
    await flush(async () => vi.advanceTimersByTime(lingerMs('好的。') - 200));
    fireEvent.mouseEnter(card);
    await flush(async () => vi.advanceTimersByTime(20_000));
    screen.getByText('好的。');
    fireEvent.mouseLeave(card);
    await flush(async () => vi.advanceTimersByTime(1400));
    screen.getByText('好的。');
    await flush(async () => vi.advanceTimersByTime(200));
    expect(said('好的。')).toBeNull();
  });

  it('a thought pops up once: it goes after its time and does not come back; another thought does, and 关闭 puts it away', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    screen.getByText(THOUGHT.text);
    expect(document.querySelector('[data-bubble-timer]')).not.toBeNull();
    await flush(async () => vi.advanceTimersByTime(lingerMs(THOUGHT.text) - 300));
    screen.getByText(THOUGHT.text);
    await flush(async () => vi.advanceTimersByTime(600));
    expect(said(THOUGHT.text)).toBeNull();

    await b.presence(presenceOf({ sampled_at: SAMPLED + 10 }));
    expect(said(THOUGHT.text)).toBeNull();

    await b.presence(presenceOf({ thought: { ...THOUGHT, id: 't2', text: '报错换了一行。' } }));
    screen.getByText('报错换了一行。');
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(said('报错换了一行。')).toBeNull();
  });

  it('a thought her line cut short does not come back after the line', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    screen.getByText(THOUGHT.text);
    await b.line('l1', '好的。', true);
    screen.getByText('好的。');
    await flush(async () => vi.advanceTimersByTime(lingerMs('好的。') + 100));
    expect(said('好的。')).toBeNull();
    expect(said(THOUGHT.text)).toBeNull();
  });

  it('a reminder shows its time, goes after its time, and moves to native\'s history', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    const collapse = vi.spyOn(b.bridge.stack, 'collapse');
    await b.presence(presenceOf());
    await b.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' }]);
    screen.getByText('c1 组会');
    expect(document.querySelector('[data-bubble]')?.getAttribute('data-kind')).toBe('remind');
    expect(document.querySelector('[data-bubble-timer]')).not.toBeNull();
    await flush(async () => vi.advanceTimersByTime(lingerMs('c1 组会') + 100));
    expect(said('c1 组会')).toBeNull();
    expect(collapse).toHaveBeenCalledWith('rem-c1');
  });

  it('caps a line’s stay at 12 s', () => {
    expect(sayMs('好')).toBe(2120);
    expect(sayMs('长'.repeat(200))).toBe(12_000);
  });

  it('a due reminder takes the thought’s place, the newest first, with no button of its own', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    const rem = (id: string, at: number) => ({ id: `rem-${id}`, kind: 'notice' as const, variant: 'reminder' as const, at, title: `${id} 组会`, commitment_id: id });
    await b.cards([rem('c1', SAMPLED * 1000 - 60_000), rem('c2', SAMPLED * 1000)]);
    screen.getByText('c2 组会');
    expect(said('c1 组会')).toBeNull();
    expect(said(THOUGHT.text)).toBeNull();
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull();
    expect(screen.queryByRole('button', { name: '稍后' })).toBeNull();
  });

  it('has no 正在做 row', async () => {
    mountBubble();
    expect(document.querySelector('[data-bubble-doing]')).toBeNull();
  });

  it('an open input command unfolds 快速输入 under the bubble; esc folds it and hands the key back', async () => {
    const b = mountBubble();
    const releaseKey = vi.spyOn(b.bridge.window, 'releaseKey');
    await b.presence(presenceOf());
    expect(screen.queryByRole('dialog', { name: '快速输入' })).toBeNull();
    await b.command({ kind: 'open', mode: 'input', prefill: '派发任务：' });
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe('派发任务：');
    screen.getByText(THOUGHT.text);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '快速输入' })).toBeNull();
    expect(releaseKey).toHaveBeenCalledTimes(1);
  });

  it('a notice command shows its line in the bubble for 4 s, beside her thought', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.command({ kind: 'notice', text: '角色在忙，等这一轮做完' });
    screen.getByText('角色在忙，等这一轮做完');
    screen.getByText(THOUGHT.text);
    await flush(async () => vi.advanceTimersByTime(3900));
    screen.getByText('角色在忙，等这一轮做完');
    await flush(async () => vi.advanceTimersByTime(200));
    expect(said('角色在忙，等这一轮做完')).toBeNull();
  });

  it('a drop card opens 快速输入 with a scope over its files', async () => {
    const b = mountBubble();
    const SCOPE: AgentdResponse<unknown> = { status: 201, body: { scope_id: 's1', expires_at: SAMPLED + 86400, files: [{ path: '/a/周报.md' }, { path: '/a/notes.txt' }], roots: [], unsupported: [] } };
    const request = vi.spyOn(b.bridge.agentd, 'request').mockImplementation(async (method, path) => (`${method} ${path}` === 'POST /agent/scopes' ? SCOPE : { status: 404, body: null }));
    // Native answers quickInput with the scope, then the open.
    const action = vi.spyOn(b.bridge.desktop, 'action').mockImplementation(async (name, arg) => {
      if (name !== 'quickInput') return;
      if (arg) await b.command({ kind: 'scope', ...(JSON.parse(arg) as { scopeId: string; files: number }) });
      await b.command({ kind: 'open', mode: 'input' });
    });
    await b.presence(presenceOf());
    const drop = {
      id: 'drop-1',
      kind: 'notice' as const,
      variant: 'drop' as const,
      at: SAMPLED * 1000,
      title: '拖给角色 │ 2 项',
      truncated: false,
      items: [
        { kind: 'file' as const, path: '/a/周报.md', name: '周报.md', handle: 'H:周报.md' },
        { kind: 'file' as const, path: '/a/notes.txt', name: 'notes.txt', handle: 'H:notes.txt' },
      ],
    };
    await b.cards([drop]);
    await flush(async () => {});
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: [{ handle: 'H:周报.md' }, { handle: 'H:notes.txt' }] });
    expect(action).toHaveBeenCalledWith('quickInput', JSON.stringify({ scopeId: 's1', files: 2 }));
    within(screen.getByRole('dialog', { name: '快速输入' })).getByText('可读取 2 个文件');
    // The same card pushed again does not open it a second time.
    await b.cards([drop]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('a drop card sends dropped links, text and unreadable file paths with the next message, and warns about unreadable file types', async () => {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue(NO_SUPPORTED);
    vi.spyOn(b.bridge.desktop, 'action').mockImplementation(async (name, arg) => {
      if (name !== 'quickInput') return;
      if (arg) await b.command({ kind: 'scope', ...(JSON.parse(arg) as { scopeId: string; files: number }) });
      await b.command({ kind: 'open', mode: 'input' });
    });
    await b.presence(presenceOf());
    await b.cards([
      {
        id: 'drop-mixed',
        kind: 'notice',
        variant: 'drop',
        at: SAMPLED * 1000,
        title: '拖给角色 │ 3 项',
        truncated: false,
        items: [
          { kind: 'url', url: 'https://example.com/spec' },
          { kind: 'text', text: '周五前交报销单' },
          { kind: 'file', path: '/a/合同.pdf', name: '合同.pdf', handle: 'H:合同.pdf' },
        ],
      },
    ]);
    await flush(async () => {});
    const dialog = screen.getByRole('dialog', { name: '快速输入' });
    within(dialog).getByText('无法读取 .pdf 内容，将仅发送文件路径');
    const box = within(dialog).getByRole('textbox');
    fireEvent.change(box, { target: { value: '帮我看看这些' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledTimes(1);
    const sent = say.mock.calls[0]![0];
    expect(sent.text).toContain('帮我看看这些');
    expect(sent.text).toMatch(/拖/);
    expect(sent.text).toContain('https://example.com/spec');
    expect(sent.text).toContain('周五前交报销单');
    expect(sent.text).toContain('/a/合同.pdf');
  });

  it('cuts a long dropped text so the message stays within the 2000 characters /say takes', async () => {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    vi.spyOn(b.bridge.desktop, 'action').mockImplementation(async (name, arg) => {
      if (name !== 'quickInput') return;
      if (arg) await b.command({ kind: 'scope', ...(JSON.parse(arg) as { scopeId: string; files: number }) });
      await b.command({ kind: 'open', mode: 'input' });
    });
    await b.presence(presenceOf());
    await b.cards([
      { id: 'drop-long', kind: 'notice', variant: 'drop', at: SAMPLED * 1000, title: '拖给角色 │ 1 项', truncated: false,
        items: [{ kind: 'text', text: '长'.repeat(3000) }] },
    ]);
    await flush(async () => {});
    const box = within(screen.getByRole('dialog', { name: '快速输入' })).getByRole('textbox');
    fireEvent.change(box, { target: { value: '请总结' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    const sent = say.mock.calls[0]![0];
    expect([...sent.text].length).toBeLessThanOrEqual(2000);
    expect(sent.text.startsWith('请总结')).toBe(true);
    expect(sent.text).toContain('长长长');
  });

  /** A drop of a pdf and a folder, whose name has no suffix. */
  const PDF_AND_FOLDER: StackPayload['cards'][number] = {
    id: 'drop-pdf',
    kind: 'notice',
    variant: 'drop',
    at: SAMPLED * 1000,
    title: '拖给角色 │ 2 项',
    truncated: false,
    items: [
      { kind: 'file', path: '/a/a.pdf', name: 'a.pdf', handle: 'H:a.pdf' },
      { kind: 'file', path: '/a/资料', name: '资料', handle: 'H:资料' },
    ],
  };
  const FOLDER_SCOPE = (unsupported: Array<{ path: string; reason: string }>): AgentdResponse<unknown> => ({
    status: 201,
    body: { scope_id: 's2', expires_at: SAMPLED + 86400, files: [], roots: [{ path: '/a/资料' }], unsupported },
  });

  it('shows a drop-open failure even with no reminder, and clears it on a later drop', async () => {
    const b = mountBubble();
    vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue(FOLDER_SCOPE([]));
    const action = vi.spyOn(b.bridge.desktop, 'action')
      .mockRejectedValueOnce(Object.assign(new Error('failed: 窗口不可用'), { detail: '窗口不可用' }))
      .mockResolvedValueOnce(undefined);
    const collapse = vi.spyOn(b.bridge.stack, 'collapse');
    await b.cards([PDF_AND_FOLDER]);
    expect(screen.getByRole('alert').textContent).toBe('快速输入没有打开：窗口不可用');
    expect(collapse).not.toHaveBeenCalled();
    await b.cards([{ ...PDF_AND_FOLDER, id: 'drop-retry', at: PDF_AND_FOLDER.at + 1 }]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(action).toHaveBeenCalledTimes(2);
    expect(collapse).toHaveBeenCalledWith('drop-retry');
  });

  /** The bubble with a drop of `card`, agentd answering `POST /agent/scopes` with `scope`, and native opening 快速输入 for it. */
  async function dropped(card: StackPayload['cards'][number], scope: AgentdResponse<unknown>) {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    const request = vi.spyOn(b.bridge.agentd, 'request').mockImplementation(async (method, path) => (`${method} ${path}` === 'POST /agent/scopes' ? scope : { status: 404, body: null }));
    const action = vi.spyOn(b.bridge.desktop, 'action').mockImplementation(async (name, arg) => {
      if (name !== 'quickInput') return;
      if (arg) await b.command({ kind: 'scope', ...(JSON.parse(arg) as { scopeId: string; files: number }) });
      await b.command({ kind: 'open', mode: 'input' });
    });
    await b.presence(presenceOf());
    await b.cards([card]);
    await flush(async () => {});
    const box = within(screen.getByRole('dialog', { name: '快速输入' })).getByRole('textbox');
    const send = async (text: string) => {
      fireEvent.change(box, { target: { value: text } });
      await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
      return say.mock.calls[0]![0];
    };
    return { request, action, send };
  }

  it('a drop asks agentd about every dropped file, a folder or a pdf too', async () => {
    const { request } = await dropped(PDF_AND_FOLDER, FOLDER_SCOPE([{ path: '/a/a.pdf', reason: 'unsupported_type' }]));
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: [{ handle: 'H:a.pdf' }, { handle: 'H:资料' }] });
  });

  it('a scope over a folder counts it, and only the paths agentd cannot read go into the message', async () => {
    const { action, send } = await dropped(PDF_AND_FOLDER, FOLDER_SCOPE([{ path: '/a/a.pdf', reason: 'unsupported_type' }]));
    expect(action).toHaveBeenCalledWith('quickInput', JSON.stringify({ scopeId: 's2', files: 1 }));
    const sent = await send('看一下');
    expect(sent.text).toContain('文件路径：/a/a.pdf');
    expect(sent.text).not.toContain('/a/资料');
    expect(sent.scopeId).toBe('s2');
  });

  it('no_supported_files still opens 快速输入, and every dropped path goes into the message without a scope', async () => {
    const { action, send } = await dropped(PDF_AND_FOLDER, NO_SUPPORTED);
    expect(action).toHaveBeenCalledWith('quickInput');
    const sent = await send('看一下');
    expect(sent.text).toContain('文件路径：/a/a.pdf');
    expect(sent.text).toContain('文件路径：/a/资料');
    expect(sent.scopeId).toBeUndefined();
  });

  it('⏎ with nothing typed sends 看看这些 with the drop’s scope', async () => {
    const { send } = await dropped(PDF_AND_FOLDER, FOLDER_SCOPE([]));
    const sent = await send('');
    expect(sent.text).toBe('看看这些');
    expect(sent.scopeId).toBe('s2');
  });
});

const NO_SUPPORTED: AgentdResponse<unknown> = { status: 400, body: { error: 'no_supported_files' }, error: { code: 'no_supported_files' } };

describe('the bubble’s thought and mute', () => {
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

  it('shows the thought while presence carries one, and none once it is gone or proactive speech is off', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    screen.getByText(THOUGHT.text);
    await b.presence(presenceOf({ thought: null }));
    expect(said(THOUGHT.text)).toBeNull();
    await b.presence(presenceOf({ proactive_speech: false }));
    expect(said(THOUGHT.text)).toBeNull();
    expect(said('想法需要打开「主动发言」')).toBeNull();
  });

  it('keeps a thought without a reply visible and offers no button for it', async () => {
    const b = mountBubble();
    const { reply: _reply, ...old } = THOUGHT;
    await b.presence(presenceOf({ thought: old }));
    screen.getByText(THOUGHT.text);
    expect(screen.queryByRole('button', { name: THOUGHT.offer })).toBeNull();
    await b.presence(presenceOf({ thought: { ...THOUGHT, reply: null } }));
    expect(screen.queryByRole('button', { name: THOUGHT.offer })).toBeNull();
  });

  it('关闭此类 adds thought to the muted kinds with PUT /proactive/mutes, and 撤销 puts the list back', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockImplementation(async (method: string, _path: string, body?: unknown) =>
      (method === 'GET' ? { status: 200, body: { muted: ['comment'] } } : { status: 200, body }) as AgentdResponse<never>,
    );
    await b.presence(presenceOf());
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭此类' })));
    const puts = () => request.mock.calls.filter((c) => c[0] === 'PUT');
    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(['GET', '/proactive/mutes']);
    expect(puts()).toEqual([['PUT', '/proactive/mutes', { muted: ['comment', 'thought'] }]]);
    expect(said(THOUGHT.text)).toBeNull();
    screen.getByText('已关闭此类想法提示，后续不再显示');
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '撤销' })));
    expect(puts().at(-1)).toEqual(['PUT', '/proactive/mutes', { muted: ['comment'] }]);
    screen.getByText(THOUGHT.text);
  });

  it('回复 sends what is typed under it from the bubble_reply surface', async () => {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    vi.spyOn(b.bridge.desktop, 'action').mockResolvedValue();
    await b.presence(presenceOf());
    await b.line('q1', '要不要我帮你看看？', true);
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '回复' })));
    const box = within(screen.getByRole('dialog', { name: '快速输入' })).getByRole('textbox');
    fireEvent.change(box, { target: { value: '好啊' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({
      text: '好啊',
      attachWindow: false,
      noMemory: false,
      surface: 'bubble_reply',
      replyTo: { kind: 'line', id: 'q1' },
    });
  });

  it('shows a native quick-input failure and clears it when the window recovers', async () => {
    const b = mountBubble();
    const action = vi.spyOn(b.bridge.desktop, 'action').mockRejectedValueOnce(new Error('快速输入窗口还未就绪'));
    await b.line('l1', '要接着做吗？', true);
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: /^回复$/ })));
    expect(action).toHaveBeenCalledWith('quickInput');
    expect(screen.getByRole('alert').textContent).toBe('快速输入窗口还未就绪');
    await b.command({ kind: 'open', mode: 'input' });
    expect(screen.queryByRole('alert')).toBeNull();
    screen.getByRole('dialog', { name: '快速输入' });
  });

  it('draws 回复 as a bare pill with no icon', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    const reply = screen.getByRole('button', { name: '回复' });
    expect(reply.querySelector('svg')).toBeNull();
    expect(reply.textContent).toBe('回复');
  });

  it('回复 on a thought sends it as the thought it answers', async () => {
    const b = mountBubble();
    const say = vi.spyOn(b.bridge.desktop, 'say');
    vi.spyOn(b.bridge.desktop, 'action').mockResolvedValue();
    await b.presence(presenceOf());
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '回复' })));
    const box = within(screen.getByRole('dialog', { name: '快速输入' })).getByRole('textbox');
    fireEvent.change(box, { target: { value: '是同一个' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({
      text: '是同一个',
      attachWindow: false,
      noMemory: false,
      surface: 'bubble_reply',
      replyTo: { kind: 'thought', id: 't1' },
    });
  });

  it('复制 writes her line to the clipboard', async () => {
    const b = mountBubble();
    const write = vi.spyOn(b.bridge.clipboard, 'writeText');
    await b.presence(presenceOf());
    await b.line('r1', 'Le renard brun.', true);
    openMore();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(write).toHaveBeenCalledWith('Le renard brun.');
  });

  it('关闭此类 on a line she said on her own posts /feedback with mute', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await b.line('d-pro', '要不要我帮你把报错整理一下？', true, { code: 'long_dwell', kind: 'comment', text: '你在这个窗口停了 12 分钟', dwell_min: 12 });
    openMore();
    fireEvent.click(screen.getByRole('button', { name: '关闭此类' }));
    expect(request).toHaveBeenCalledWith('POST', '/feedback', { line_id: 'd-pro', value: 'dont_disturb', mute: true });
  });

  it('drags by the strip along its top, reported as a drag region without hovering', async () => {
    const b = mountBubble();
    const report = vi.spyOn(b.bridge.window, 'setInteractiveRegions');
    await b.presence(presenceOf());
    const drags = document.querySelectorAll<HTMLElement>('[data-drag]');
    expect(drags).toHaveLength(1);
    expect(drags[0]!.parentElement?.hasAttribute('data-bubble')).toBe(true);
    await flush(async () => {});
    expect(report.mock.calls.at(-1)?.[0].some((r) => r.drag === true)).toBe(true);
  });

  it('关闭 closes her line now, without muting its kind', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await b.line('c1', '我先去看看日志。', true);
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(said('我先去看看日志。')).toBeNull();
    // The thought her line replaced has had its one showing.
    expect(said(THOUGHT.text)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('关闭 hides this thought until another one arrives, without muting thoughts', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(said(THOUGHT.text)).toBeNull();
    await b.presence(presenceOf({ sampled_at: SAMPLED + 5 }));
    expect(said(THOUGHT.text)).toBeNull();
    expect(request.mock.calls).toEqual([['POST', '/feedback', { line_id: 't1', value: 'dismissed' }]]);
    await b.presence(presenceOf({ thought: { ...THOUGHT, id: 't2', text: '窗口里的报错换了一条。' } }));
    screen.getByText('窗口里的报错换了一条。');
  });

  it('关闭 on a line she said on her own posts /feedback dismissed', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await b.line('d-pro', '要不要我帮你把报错整理一下？', true, { code: 'long_dwell', kind: 'comment', text: '你在这个窗口停了 12 分钟', dwell_min: 12 });
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(said('要不要我帮你把报错整理一下？')).toBeNull();
    expect(request.mock.calls).toEqual([['POST', '/feedback', { line_id: 'd-pro', value: 'dismissed' }]]);
  });

  it('有用 and 少说点 show on her own line and on a thought, not on a reply', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    openMore();
    screen.getByRole('button', { name: '有帮助' });
    screen.getByRole('button', { name: '减少此类提示' });
    await b.line('c1', '我先去看看日志。', true);
    openMore();
    expect(screen.queryByRole('button', { name: '有帮助' })).toBeNull();
    expect(screen.queryByRole('button', { name: '减少此类提示' })).toBeNull();
    await b.line('d-pro', '要不要我帮你把报错整理一下？', true, { code: 'stuck', kind: 'stuck' });
    openMore();
    screen.getByRole('button', { name: '有帮助' });
    screen.getByRole('button', { name: '减少此类提示' });
  });

  it('少说点 posts /feedback less once and shows it was sent, until the next thought', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '减少此类提示' })));
    expect(request.mock.calls).toEqual([['POST', '/feedback', { line_id: 't1', value: 'less' }]]);
    const sent = screen.getByRole('button', { name: '减少此类提示（已发送）' });
    expect(sent.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '有帮助' }).hasAttribute('disabled')).toBe(true);
    await b.presence(presenceOf({ thought: { ...THOUGHT, id: 't2', text: '窗口里的报错换了一条。' } }));
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '有帮助' })));
    expect(request.mock.calls.at(-1)).toEqual(['POST', '/feedback', { line_id: 't2', value: 'useful' }]);
    screen.getByRole('button', { name: '有帮助（已发送）' });
  });

  it('a refused 有用 is not shown as sent', async () => {
    const b = mountBubble();
    vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 404, body: null });
    await b.presence(presenceOf());
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '有帮助' })));
    expect(screen.getByRole('button', { name: '有帮助' }).hasAttribute('disabled')).toBe(false);
  });

  it('an accepted turn shows 在想 in place of her thought, until her first word fills the card', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.accepted('u1');
    screen.getByText('思考中');
    expect(said(THOUGHT.text)).toBeNull();
    await b.line('u1', '我看看。');
    expect(said('在想')).toBeNull();
    screen.getByText('我看看。');
  });

  it('while she is hidden an accepted turn shows 在想 in the subtitle bar, then her line there', async () => {
    const b = mountBubble();
    vi.spyOn(b.bridge.window, 'onAnchor').mockImplementation((cb) => {
      cb({ panel: 'bubble', state: 'docked', side: 'menubar', docked: 'hidden', far: false, toHead: null, room: { width: 400, height: 200 } });
      return () => {};
    });
    cleanup();
    render(<BubbleRoot />);
    await b.accepted('u1');
    const bar = document.querySelector<HTMLElement>('[data-subtitle]')!;
    expect(bar.textContent).toContain('思考中');
    await b.line('u1', '我看看。');
    expect(bar.isConnected && document.querySelector('[data-subtitle]')!.textContent).toContain('我看看。');
    expect(document.querySelector('[data-subtitle]')!.textContent).not.toContain('思考中');
  });

  it('a due reminder offers neither 关闭 nor 更多操作 of its own', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' }]);
    screen.getByText('c1 组会');
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });

  it('a due reminder drawn in the bubble posts /commitments/<id>/seen, every commitment of a merged reminder_due', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await b.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' }]);
    screen.getByText('c1 组会');
    expect(request).toHaveBeenCalledWith('POST', '/commitments/c1/seen', {});
    const merged = { id: 'announce-7', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000 + 1, title: '两条到点', commitment_id: 'a', commitment_ids: ['a', 'b'] };
    await b.cards([merged as StackPayload['cards'][number]]);
    expect(request).toHaveBeenCalledWith('POST', '/commitments/a/seen', {});
    expect(request).toHaveBeenCalledWith('POST', '/commitments/b/seen', {});
  });

  it('a due reminder posts no seen while she is hidden and the bubble does not draw it', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    vi.spyOn(b.bridge.window, 'onAnchor').mockImplementation((cb) => {
      cb({ panel: 'bubble', state: 'docked', side: 'menubar', docked: 'hidden', far: false, toHead: null, room: { width: 400, height: 200 } });
      return () => {};
    });
    cleanup();
    render(<BubbleRoot />);
    await b.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' }]);
    expect(said('c1 组会')).toBeNull();
    expect(request.mock.calls.filter(([, path]) => String(path).endsWith('/seen'))).toHaveLength(0);
  });

  it('a due reminder under an approval card posts no seen until the approval goes and it is drawn', async () => {
    const approval = bubbleCards('confirm')!.cards[0]!;
    const reminder = { id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' } as const;
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    const seen = () => request.mock.calls.filter(([, path]) => String(path).endsWith('/seen'));
    await b.presence(presenceOf());
    await b.cards([approval, reminder]);
    expect(screen.getByRole('alertdialog', { name: /^待批准：/ })).toBeTruthy();
    expect(screen.queryByText('c1 组会')).toBeNull();
    expect(seen()).toHaveLength(0);
    await b.cards([reminder]);
    screen.getByText('c1 组会');
    expect(seen()).toEqual([['POST', '/commitments/c1/seen', {}]]);
  });
});

describe('her reply in the bubble: side answers, endings, errors and 停止', () => {
  const MAIN = '正在跑完整测试。';
  const SIDE = '那个文件在 web 下面，我只读看了一眼。';
  const before = (a: string, b: string) => {
    const all = document.body.textContent ?? '';
    return all.indexOf(a) >= 0 && all.indexOf(a) < all.indexOf(b);
  };

  it('a side answer shows under the foreground line and stays while it shows', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf({ thought: null }));
    await b.send('line', { line_id: 'r1', text_delta: MAIN, lane: 'agent' });
    await b.send('line', { line_id: 's1', text_delta: SIDE, lane: 'side' });
    await b.send('line', { line_id: 's1', lane: 'side', final: true });
    screen.getByText(MAIN);
    screen.getByText(SIDE);
    expect(before(MAIN, SIDE)).toBe(true);
    expect(screen.getAllByRole('button', { name: '停止' })).toHaveLength(1);
    await flush(async () => vi.advanceTimersByTime(lingerMs(SIDE) + 5000));
    screen.getByText(SIDE);
  });

  it('while she is hidden the subtitle bar shows the side answer under the foreground line', async () => {
    const b = mountBubble();
    b.dock();
    await b.send('line', { line_id: 'r1', text_delta: MAIN, lane: 'agent' });
    await b.send('line', { line_id: 's1', text_delta: SIDE, lane: 'side' });
    const bars = [...document.querySelectorAll('[data-subtitle]')].map((el) => el.textContent);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toContain(MAIN);
    expect(bars[1]).toContain(SIDE);
  });

  it('a reset or a gap in the feed ends her open line with why', async () => {
    const b = mountBubble();
    await b.presence(presenceOf({ thought: null }));
    await b.send('line', { line_id: 'l1', text_delta: '我看看' });
    await b.send('reset');
    screen.getByText('后台已重启，这一轮没有完成');
    await b.accepted('u2');
    await b.send('gap');
    screen.getByText('后台已重启，这一轮没有完成');
  });

  it('an error says why and offers its next step, which opens the main window there', async () => {
    const b = mountBubble();
    const open = vi.spyOn(b.bridge.window, 'openMain');
    await b.presence(presenceOf({ thought: null }));
    await b.send('line', { line_id: 'e1', text_delta: '我去读一下', final: true, error: 'auth_expired' });
    screen.getByText('登录已过期，请重新登录');
    expect(said('本轮回复出错，未能完整输出')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '前往登录' }));
    expect(open).toHaveBeenCalledWith(navRoute({ page: 'settings', group: 'kernel', item: 'kcur' }));
  });

  it('the subtitle bar shows an error and an interruption as the bubble does', async () => {
    const b = mountBubble();
    const open = vi.spyOn(b.bridge.window, 'openMain');
    b.dock();
    await b.send('line', { line_id: 'e1', text_delta: '我去读一下', final: true, error: 'quota_exhausted' });
    const bar = () => document.querySelector('[data-subtitle]')!;
    expect(bar().textContent).toContain('可用额度已用完，请检查账户额度');
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: '查看用量' }));
    expect(open).toHaveBeenCalledWith(navRoute({ page: 'diag', tab: 'flow', item: 'usage' }));
    await b.send('line', { line_id: 'c1', text_delta: '说到一半' });
    await b.send('line', { line_id: 'c1', final: true, cancelled: true });
    expect(bar().textContent).toContain('说到一半');
    expect(bar().textContent).toContain('已打断');
  });

  it('停止 on her thinking or streaming line cancels the turn; ✕ only hides the line', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 202, body: {} });
    await b.presence(presenceOf({ thought: null }));
    await b.accepted('u1');
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '停止' })));
    expect(request.mock.calls).toEqual([['POST', '/turn/cancel', { reason: 'client_cancel', line_id: 'u1' }]]);
    await b.line('u1', '我看看。');
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '停止' })));
    expect(request.mock.calls).toHaveLength(2);
    await b.line('u1', '', true);
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    await b.line('u2', '再说一句。');
    request.mockClear();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(said('再说一句。')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
