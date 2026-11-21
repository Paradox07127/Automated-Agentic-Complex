import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse, DesktopCommand, AgenticComplexBridge, StackPayload, StreamEvent } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import { sayMs } from '../../src/surfaces/desktop/bubble/sayTime';
import { stubMatchMedia } from './mediaStub';

// The thought bubble beside her head (`#/bubble`): thought, her line, a due reminder, the 正在做 row, and 快速输入
// under it, opened by a command or by a drop. Which states draw no card is in status-chip.test.tsx.

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
  };
}

const presenceOf = (extra: Record<string, unknown> = {}) => ({ sampled_at: SAMPLED, proactive_speech: true, thought: THOUGHT, role: RUNNING, ...extra });
const doingRow = () => document.querySelector<HTMLElement>('[data-bubble-doing]')?.textContent ?? '';

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

  it('a finished line collapses to the icon after sayMs; clicking the icon brings the card back, and a new line shows the card', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    const text = '构建失败在第 42 行，补上分号再跑一次。';
    await b.line('l1', text);
    expect(document.querySelector('[data-bubble-timer]')).toBeNull();
    await b.line('l1', '', true);
    screen.getByText(text);
    expect(document.querySelector('[data-bubble-timer]')).not.toBeNull();
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    await flush(async () => vi.advanceTimersByTime(sayMs(text) - 300));
    screen.getByText(text);
    await flush(async () => vi.advanceTimersByTime(600));
    expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    const icon = screen.getByRole('button', { name: '展开消息' });
    expect(icon.getAttribute('title')).toContain('构建失败在第 42 行');

    fireEvent.click(icon);
    screen.getByText(text);
    expect(screen.queryByRole('button', { name: '展开消息' })).toBeNull();
    await flush(async () => vi.advanceTimersByTime(sayMs(text) - 300));
    screen.getByText(text);
    await flush(async () => vi.advanceTimersByTime(600));
    screen.getByRole('button', { name: '展开消息' });

    await b.line('l2', '新的一句。', true);
    screen.getByText('新的一句。');
    expect(screen.queryByRole('button', { name: '展开消息' })).toBeNull();
  });

  it('hover pauses the countdown and leaves at least 1500 ms after the pointer leaves', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.line('l2', '好的。', true);
    const card = document.querySelector<HTMLElement>('[data-bubble]');
    if (!card) throw new Error('no bubble');
    await flush(async () => vi.advanceTimersByTime(sayMs('好的。') - 200));
    fireEvent.mouseEnter(card);
    await flush(async () => vi.advanceTimersByTime(20_000));
    screen.getByText('好的。');
    fireEvent.mouseLeave(card);
    await flush(async () => vi.advanceTimersByTime(1400));
    screen.getByText('好的。');
    await flush(async () => vi.advanceTimersByTime(200));
    expect(screen.queryByText('好的。')).toBeNull();
    screen.getByRole('button', { name: '展开消息' });
  });

  it('a thought collapses to the icon after sayMs, reopens on click, and a new thought or 关闭 resets it', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    screen.getByText(THOUGHT.text);
    expect(document.querySelector('[data-bubble-timer]')).not.toBeNull();
    await flush(async () => vi.advanceTimersByTime(sayMs(THOUGHT.text) - 300));
    screen.getByText(THOUGHT.text);
    await flush(async () => vi.advanceTimersByTime(600));
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    const icon = screen.getByRole('button', { name: '展开消息' });
    expect(icon.getAttribute('title')).toContain('测试又红了');

    await b.presence(presenceOf({ sampled_at: SAMPLED + 10 }));
    screen.getByRole('button', { name: '展开消息' });

    fireEvent.click(icon);
    screen.getByText(THOUGHT.text);
    await flush(async () => vi.advanceTimersByTime(sayMs(THOUGHT.text) + 100));
    screen.getByRole('button', { name: '展开消息' });

    await b.presence(presenceOf({ thought: { ...THOUGHT, text: '报错换了一行。' } }));
    screen.getByText('报错换了一行。');
    expect(screen.queryByRole('button', { name: '展开消息' })).toBeNull();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(screen.queryByText('报错换了一行。')).toBeNull();
    expect(screen.queryByRole('button', { name: '展开消息' })).toBeNull();
  });

  it('a reminder has no countdown bar and never collapses', async () => {
    vi.useFakeTimers();
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' }]);
    screen.getByText('c1 组会');
    expect(document.querySelector('[data-bubble-timer]')).toBeNull();
    await flush(async () => vi.advanceTimersByTime(60_000));
    screen.getByText('c1 组会');
    expect(screen.queryByRole('button', { name: '展开消息' })).toBeNull();
  });

  it('caps a line’s stay at 12 s', () => {
    expect(sayMs('好')).toBe(2120);
    expect(sayMs('长'.repeat(200))).toBe(12_000);
  });

  it('a due reminder takes the thought’s place; 知道了 completes it and 稍后 snoozes it 10 minutes', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: { commitment: { due_at: SAMPLED + 600 } } });
    const collapse = vi.spyOn(b.bridge.stack, 'collapse');
    await b.presence(presenceOf());
    const rem = (id: string, at: number) => ({ id: `rem-${id}`, kind: 'notice' as const, variant: 'reminder' as const, at, title: `${id} 组会`, commitment_id: id });
    await b.cards([rem('c1', SAMPLED * 1000 - 60_000), rem('c2', SAMPLED * 1000)]);
    screen.getByText('c2 组会');
    expect(screen.queryByText('c1 组会')).toBeNull();
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '知道了' })));
    expect(request).toHaveBeenCalledWith('POST', '/commitments/c2/complete', undefined);
    expect(collapse).toHaveBeenCalledWith('rem-c2');
    screen.getByText('c1 组会');
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '稍后' })));
    expect(request).toHaveBeenLastCalledWith('POST', '/commitments/c1/snooze', { minutes: 10 });
    expect(collapse).toHaveBeenLastCalledWith('rem-c1');
    screen.getByText(THOUGHT.text);
  });

  it('the 正在做 row reads role.doing with the minutes since the run began, and falls back without it', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    expect(doingRow()).toBe('▸ 在跑 swift test │ 4 分钟');
    await b.presence(presenceOf({ role: { ...RUNNING, doing: undefined } }));
    expect(doingRow()).toBe('▸ 我在跑测试。 │ 4 分钟');
    await b.presence(presenceOf({ role: { ...RUNNING, doing: undefined, intention: null } }));
    expect(doingRow()).toBe('▸ 在跑 │ 4 分钟');
    await b.presence(presenceOf({ role: { state: 'idle', activity: '陪着你' } }));
    expect(doingRow()).toBe('▸ 陪着你');
  });

  it('the 正在做 row says 连不上后台 while native marks agentd offline, and reads the next presence again', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.presence({ offline: true });
    expect(doingRow()).toBe('▸ 连不上后台');
    screen.getByText(THOUGHT.text);
    await b.presence(presenceOf());
    expect(doingRow()).toBe('▸ 在跑 swift test │ 4 分钟');
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
    await b.command({ kind: 'notice', text: '她在忙，等这一轮做完' });
    screen.getByText('她在忙，等这一轮做完');
    screen.getByText(THOUGHT.text);
    await flush(async () => vi.advanceTimersByTime(3900));
    screen.getByText('她在忙，等这一轮做完');
    await flush(async () => vi.advanceTimersByTime(200));
    expect(screen.queryByText('她在忙，等这一轮做完')).toBeNull();
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
      title: '交给她 │ 2 项',
      truncated: false,
      items: [
        { kind: 'file' as const, path: '/a/周报.md', name: '周报.md' },
        { kind: 'file' as const, path: '/a/notes.txt', name: 'notes.txt' },
      ],
    };
    await b.cards([drop]);
    await flush(async () => {});
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: ['/a/周报.md', '/a/notes.txt'] });
    expect(action).toHaveBeenCalledWith('quickInput', JSON.stringify({ scopeId: 's1', files: 2 }));
    within(screen.getByRole('dialog', { name: '快速输入' })).getByText('可读 2 个文件');
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
        title: '交给她 │ 3 项',
        truncated: false,
        items: [
          { kind: 'url', url: 'https://example.com/spec' },
          { kind: 'text', text: '周五前交报销单' },
          { kind: 'file', path: '/a/合同.pdf', name: '合同.pdf' },
        ],
      },
    ]);
    await flush(async () => {});
    const dialog = screen.getByRole('dialog', { name: '快速输入' });
    within(dialog).getByText('读不了 .pdf，只把路径发给她');
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
      { id: 'drop-long', kind: 'notice', variant: 'drop', at: SAMPLED * 1000, title: '交给她 │ 1 项', truncated: false,
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
    title: '交给她 │ 2 项',
    truncated: false,
    items: [
      { kind: 'file', path: '/a/a.pdf', name: 'a.pdf' },
      { kind: 'file', path: '/a/资料', name: '资料' },
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
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: ['/a/a.pdf', '/a/资料'] });
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
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    await b.presence(presenceOf({ proactive_speech: false }));
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    expect(screen.queryByText('想法需要打开「主动发言」')).toBeNull();
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
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    screen.getByText('已关闭想法，以后不再显示');
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

  it('drags by the whole header, grip and 正在做 row, and reports it as a drag region without hovering', async () => {
    const b = mountBubble();
    const report = vi.spyOn(b.bridge.window, 'setInteractiveRegions');
    await b.presence(presenceOf());
    const drags = document.querySelectorAll<HTMLElement>('[data-drag]');
    expect(drags).toHaveLength(1);
    expect(drags[0]!.tagName).toBe('HEADER');
    expect(drags[0]!.querySelector('[aria-label="拖动气泡；双击回到默认位置"]')).not.toBeNull();
    expect(drags[0]!.querySelector('[data-bubble-doing]')).not.toBeNull();
    await flush(async () => {});
    expect(report.mock.calls.at(-1)?.[0].some((r) => r.drag === true)).toBe(true);
  });

  it('关闭 closes her line now, without muting its kind', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await b.line('c1', '我先去看看日志。', true);
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(screen.queryByText('我先去看看日志。')).toBeNull();
    screen.getByText(THOUGHT.text);
    expect(request).not.toHaveBeenCalled();
  });

  it('关闭 hides this thought until another one arrives, without muting thoughts', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '关闭' })));
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    await b.presence(presenceOf({ sampled_at: SAMPLED + 5 }));
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
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
    expect(screen.queryByText('要不要我帮你把报错整理一下？')).toBeNull();
    expect(request.mock.calls).toEqual([['POST', '/feedback', { line_id: 'd-pro', value: 'dismissed' }]]);
  });

  it('有用 and 少说点 show on her own line and on a thought, not on a reply', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    openMore();
    screen.getByRole('button', { name: '有用' });
    screen.getByRole('button', { name: '少说点' });
    await b.line('c1', '我先去看看日志。', true);
    openMore();
    expect(screen.queryByRole('button', { name: '有用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '少说点' })).toBeNull();
    await b.line('d-pro', '要不要我帮你把报错整理一下？', true, { code: 'stuck', kind: 'stuck' });
    openMore();
    screen.getByRole('button', { name: '有用' });
    screen.getByRole('button', { name: '少说点' });
  });

  it('少说点 posts /feedback less once and shows it was sent, until the next thought', async () => {
    const b = mountBubble();
    const request = vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 200, body: {} });
    await b.presence(presenceOf());
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '少说点' })));
    expect(request.mock.calls).toEqual([['POST', '/feedback', { line_id: 't1', value: 'less' }]]);
    const sent = screen.getByRole('button', { name: '少说点（已发送）' });
    expect(sent.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '有用' }).hasAttribute('disabled')).toBe(true);
    await b.presence(presenceOf({ thought: { ...THOUGHT, id: 't2', text: '窗口里的报错换了一条。' } }));
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '有用' })));
    expect(request.mock.calls.at(-1)).toEqual(['POST', '/feedback', { line_id: 't2', value: 'useful' }]);
    screen.getByRole('button', { name: '有用（已发送）' });
  });

  it('a refused 有用 is not shown as sent', async () => {
    const b = mountBubble();
    vi.spyOn(b.bridge.agentd, 'request').mockResolvedValue({ status: 404, body: null });
    await b.presence(presenceOf());
    openMore();
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '有用' })));
    expect(screen.getByRole('button', { name: '有用' }).hasAttribute('disabled')).toBe(false);
  });

  it('an accepted turn leaves no card, the status chip says 在想, until her first word opens it', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.accepted('u1');
    expect(screen.queryByText('在想')).toBeNull();
    expect(screen.queryByText(THOUGHT.text)).toBeNull();
    expect(document.querySelector('[data-surface-root="bubble"] [data-region]')).toBeNull();
    await b.line('u1', '我看看。');
    expect(screen.queryByText('在想')).toBeNull();
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
    expect(bar.textContent).toContain('在想');
    await b.line('u1', '我看看。');
    expect(bar.isConnected && document.querySelector('[data-subtitle]')!.textContent).toContain('我看看。');
    expect(document.querySelector('[data-subtitle]')!.textContent).not.toContain('在想');
  });

  it('a due reminder offers no 关闭 of its own over its buttons', async () => {
    const b = mountBubble();
    await b.presence(presenceOf());
    await b.cards([{ id: 'rem-c1', kind: 'notice', variant: 'reminder', at: SAMPLED * 1000, title: 'c1 组会', commitment_id: 'c1' }]);
    screen.getByRole('button', { name: '知道了' });
    screen.getByRole('button', { name: '稍后' });
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
    expect(screen.queryByText('c1 组会')).toBeNull();
    expect(request.mock.calls.filter(([, path]) => String(path).endsWith('/seen'))).toHaveLength(0);
  });
});
