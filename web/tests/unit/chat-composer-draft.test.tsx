import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickedHandle } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockRoute } from '../../src/mock';
import { Composer, type ComposerProps, type SendOptions, type SendResult } from '../../src/pages/chat/Composer';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  delete window.agenticComplex;
});

const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({
  roleName: '陈千语',
  history: false,
  busy: false,
  kernel: null,
  failed: null,
  sending: false,
  onSend: async () => 'sent' as const,
  onResend: () => {},
  onDiscardFailed: () => {},
  onContinue: () => {},
  onRecheck: () => {},
  ...over,
});

const box = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const sendBtn = () => screen.getByRole('button', { name: '发送' });
const pickFrom = (picks: Array<() => Promise<PickedHandle | null>>, routes: MockRoute[] = []) => {
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const pickFile = vi.fn(async () => picks.shift()!());
  window.agenticComplex = { ...base, files: { ...base.files, pickFile } };
  return pickFile;
};
const attach = () => {
  fireEvent.click(screen.getByRole('button', { name: '附加' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '添加文件或图片' }));
};
const flag = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: '附加' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name }));
};

describe('composer keeps the draft until the line is taken', () => {
  it('a declined send leaves text, flags and files, and the next send still carries them', async () => {
    const scopes: unknown[] = [];
    pickFrom([async () => ({ handle: 'h-1', displayName: '销量.csv' })], [{ method: 'POST', path: '/agent/scopes', handler: ({ body }) => (scopes.push(body), { status: 201, body: {} }) }]);
    const answers: SendResult[] = ['kept', 'sent'];
    const onSend = vi.fn(async (_text: string, _options: SendOptions) => answers.shift()!);
    render(<Composer {...props({ onSend, topicId: 'keep-a' })} />);
    attach();
    await screen.findByText('销量.csv');
    flag('让陈千语看一眼屏幕');
    type('汇总一下');
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(box().value).toBe('汇总一下');
    expect(screen.getByText('销量.csv')).toBeTruthy();
    expect(screen.getByRole('button', { name: '不看屏幕' })).toBeTruthy();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]).toEqual(onSend.mock.calls[0]);
    expect(onSend.mock.calls[0]![1]).toEqual({ look: true, no_memory: false, files: [{ handle: 'h-1', displayName: '销量.csv' }] });
    await waitFor(() => expect(box().value).toBe(''));
    // The composer hands the files over; the scope is made after the user agrees, not here.
    expect(scopes).toEqual([]);
  });

  it('a declined 这句不记 send still says no_memory the second time', async () => {
    const answers: SendResult[] = ['kept', 'sent'];
    const onSend = vi.fn(async (_text: string, _options: SendOptions) => answers.shift()!);
    render(<Composer {...props({ onSend, topicId: 'keep-b' })} />);
    flag('这句不记');
    type('只说一次');
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]![1]).toEqual({ look: false, no_memory: true });
  });

  it('spent files leave the tray and the text stays', async () => {
    pickFrom([async () => ({ handle: 'h-1', displayName: '销量.csv' })]);
    render(<Composer {...props({ onSend: async () => 'spent', topicId: 'keep-c' })} />);
    attach();
    await screen.findByText('销量.csv');
    type('汇总一下');
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.queryByText('销量.csv')).toBeNull());
    expect(box().value).toBe('汇总一下');
  });

  it('a sent line clears only the draft it left, even after another topic was opened', async () => {
    let finish: (r: SendResult) => void = () => {};
    const onSend = vi.fn(() => new Promise<SendResult>((r) => (finish = r)));
    const { rerender } = render(<Composer {...props({ onSend, topicId: 'late-a' })} />);
    type('给 A');
    fireEvent.click(sendBtn());
    rerender(<Composer {...props({ onSend, topicId: 'late-b' })} />);
    type('给 B 的新草稿');
    await act(async () => finish('sent'));
    expect(box().value).toBe('给 B 的新草稿');
    rerender(<Composer {...props({ onSend, topicId: 'late-a' })} />);
    expect(box().value).toBe('');
  });

  it('a send in flight is not sent twice', async () => {
    let finish: (r: SendResult) => void = () => {};
    const onSend = vi.fn(() => new Promise<SendResult>((r) => (finish = r)));
    render(<Composer {...props({ onSend, topicId: 'twice' })} />);
    type('一次');
    fireEvent.click(sendBtn());
    fireEvent.click(sendBtn());
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => finish('sent'));
  });

  it('sending=true makes the send button do nothing', () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend, sending: true, topicId: 'busy' })} />);
    type('在吗');
    fireEvent.click(sendBtn());
    expect(onSend).not.toHaveBeenCalled();
    expect(sendBtn().getAttribute('aria-disabled')).toBe('true');
  });

  it('text over 8000 characters is stopped here, with its reason', () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend, topicId: 'long' })} />);
    type('长'.repeat(8001));
    fireEvent.click(sendBtn());
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText(/8000/)).toBeTruthy();
    type('长'.repeat(8000));
    fireEvent.click(sendBtn());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('a quote goes out as quote_turn and not as > lines', () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend, topicId: 'quote', quote: { text: '周三下午三点', turn_id: 'tr7', part: 'reply' } })} />);
    expect(screen.getByText('周三下午三点')).toBeTruthy();
    type('好的');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('好的', { look: false, no_memory: false, quote_turn: { turn_id: 'tr7', part: 'reply' } });
  });

  it('the quote clears with the sent line, not with a declined one', async () => {
    const answers: SendResult[] = ['kept', 'sent'];
    const onClearQuote = vi.fn();
    render(<Composer {...props({ onSend: async () => answers.shift()!, onClearQuote, topicId: 'quote2', quote: { text: 'x', turn_id: 'tr7', part: 'user' } })} />);
    type('好的');
    fireEvent.click(sendBtn());
    await act(async () => {});
    expect(onClearQuote).not.toHaveBeenCalled();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onClearQuote).toHaveBeenCalledTimes(1));
  });
});

describe('a finished pick, drop or paste goes to the draft that asked for it', () => {
  it('a file picked in topic A lands in A even when B is open by then', async () => {
    let done: (h: PickedHandle) => void = () => {};
    pickFrom([() => new Promise((r) => (done = r))]);
    const { rerender } = render(<Composer {...props({ topicId: 'pick-a' })} />);
    attach();
    rerender(<Composer {...props({ topicId: 'pick-b' })} />);
    await act(async () => done({ handle: 'h-1', displayName: '销量.csv' }));
    expect(screen.queryByText('销量.csv')).toBeNull();
    rerender(<Composer {...props({ topicId: 'pick-a' })} />);
    expect(screen.getByText('销量.csv')).toBeTruthy();
  });

  it('a file that arrives after 这句不记 was turned on is not added', async () => {
    let done: (h: PickedHandle) => void = () => {};
    pickFrom([() => new Promise((r) => (done = r))]);
    render(<Composer {...props({ topicId: 'pick-c' })} />);
    attach();
    flag('这句不记');
    await act(async () => done({ handle: 'h-1', displayName: '销量.csv' }));
    expect(screen.queryByText('销量.csv')).toBeNull();
  });

  it('a picker that fails says why on the note line', async () => {
    pickFrom([async () => Promise.reject(new Error('x'))]);
    render(<Composer {...props({ topicId: 'pick-d' })} />);
    attach();
    expect(await screen.findByText(/文件没带上/)).toBeTruthy();
  });

  it('at most 16 files; the rest are not adopted', async () => {
    const base = createFakeBridge({ surface: 'main', still: true });
    const adoptDropped = vi.fn(async (files: File[]) => files.map((f, i) => ({ handle: `D${i}`, displayName: f.name, size: f.size })));
    window.agenticComplex = { ...base, files: { ...base.files, adoptDropped } };
    const files = Array.from({ length: 17 }, (_, i) => new File(['x'], `f${i}.csv`));
    render(<Composer {...props({ topicId: 'many', dropped: { files, topic: 'many' } })} />);
    await waitFor(() => expect(adoptDropped).toHaveBeenCalled());
    expect(adoptDropped.mock.calls[0]![0]).toHaveLength(16);
    expect(await screen.findByText(/1 个文件没带上/)).toBeTruthy();
  });

  it('a pasted image over 5 MiB is not read; a small one is', async () => {
    const base = createFakeBridge({ surface: 'main', still: true });
    const adoptPasted = vi.fn(async (items: Array<{ type: string; data: ArrayBuffer }>) => items.map((_, i) => ({ handle: `P${i}`, displayName: `p${i}.png`, size: 1 })));
    window.agenticComplex = { ...base, files: { ...base.files, adoptPasted } };
    render(<Composer {...props({ topicId: 'img' })} />);
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');
    const small = new File([new Uint8Array([1])], 'small.png', { type: 'image/png' });
    fireEvent.paste(box(), { clipboardData: { files: [big, small], getData: () => '' } });
    await waitFor(() => expect(adoptPasted).toHaveBeenCalledTimes(1));
    expect(read).not.toHaveBeenCalled();
    expect(adoptPasted.mock.calls[0]![0]).toHaveLength(1);
    expect(await screen.findByText(/1 个文件没带上/)).toBeTruthy();
  });

  it('pasting text with an image keeps the text paste; the image is adopted', async () => {
    const base = createFakeBridge({ surface: 'main', still: true });
    const adoptPasted = vi.fn(async () => [{ handle: 'P0', displayName: 'p0.png', size: 1 }]);
    window.agenticComplex = { ...base, files: { ...base.files, adoptPasted } };
    render(<Composer {...props({ topicId: 'mixed' })} />);
    const png = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    const proceeded = fireEvent.paste(box(), { clipboardData: { files: [png], getData: () => '图注' } });
    expect(proceeded).toBe(true);
    expect(await screen.findByText('p0.png')).toBeTruthy();
  });

  it('a paste that fails to save says why', async () => {
    const base = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = { ...base, files: { ...base.files, adoptPasted: async () => Promise.reject(new Error('x')) } };
    render(<Composer {...props({ topicId: 'bad-paste' })} />);
    const png = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    fireEvent.paste(box(), { clipboardData: { files: [png], getData: () => '' } });
    expect(await screen.findByText(/文件没带上/)).toBeTruthy();
  });

  it('with the personal agent off, adding files is disabled with the reason', () => {
    pluginsReset();
    render(<Composer {...props({ topicId: 'plugin' })} />);
    fireEvent.click(screen.getByRole('button', { name: '附加' }));
    const item = screen.getByRole('menuitem', { name: /添加文件或图片/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toMatch(/已关闭：设置里关着「派发任务和定时任务」/);
  });
});

describe('injected text and drops are used once, by the topic they name', () => {
  it('a draft for another topic is not applied; one for this topic is, then reported used', () => {
    const onDraftUsed = vi.fn();
    const { rerender } = render(<Composer {...props({ topicId: 'inj-b', draft: { text: '给 A 的', topic: 'inj-a' }, onDraftUsed })} />);
    expect(box().value).toBe('');
    expect(onDraftUsed).not.toHaveBeenCalled();
    rerender(<Composer {...props({ topicId: 'inj-a', draft: { text: '给 A 的', topic: 'inj-a' }, onDraftUsed })} />);
    expect(box().value).toBe('给 A 的');
    expect(onDraftUsed).toHaveBeenCalledTimes(1);
  });

  it('an example put in after the user typed leaves the typed text', () => {
    const onDraftUsed = vi.fn();
    const { rerender } = render(<Composer {...props({ topicId: 'inj-c', onDraftUsed })} />);
    type('abc');
    rerender(<Composer {...props({ topicId: 'inj-c', draft: { text: '你能帮我做些什么？', topic: 'inj-c' }, onDraftUsed })} />);
    expect(box().value).toBe('abc');
    expect(onDraftUsed).toHaveBeenCalledTimes(1);
  });

  it('a remount with the same drop does not adopt it again once it was used', async () => {
    const base = createFakeBridge({ surface: 'main', still: true });
    const adoptDropped = vi.fn(async (files: File[]) => files.map((f, i) => ({ handle: `D${i}`, displayName: f.name, size: f.size })));
    window.agenticComplex = { ...base, files: { ...base.files, adoptDropped } };
    const doc = new File(['x'], '名单.xlsx');
    const onDroppedUsed = vi.fn();
    render(<Composer {...props({ topicId: 'drop-a', dropped: { files: [doc], topic: 'drop-b' }, onDroppedUsed })} />);
    await act(async () => {});
    expect(adoptDropped).not.toHaveBeenCalled();
    cleanup();
    render(<Composer {...props({ topicId: 'drop-b', dropped: { files: [doc], topic: 'drop-b' }, onDroppedUsed })} />);
    await waitFor(() => expect(adoptDropped).toHaveBeenCalledTimes(1));
    expect(onDroppedUsed).toHaveBeenCalledTimes(1);
  });
});

describe('the main kernel does not gate the input', () => {
  it('a kernel that is not ready leaves the box and 发送 working and shows only the notice', async () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend, topicId: 'kernel', kernel: { id: 'codex', name: 'Codex', available: false, reason: null } as ComposerProps['kernel'] })} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(box().disabled).toBe(false);
    type('早上好');
    fireEvent.click(sendBtn());
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
