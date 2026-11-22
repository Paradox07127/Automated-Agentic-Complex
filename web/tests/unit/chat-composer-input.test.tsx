import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickedHandle } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MockResponse, MockRoute } from '../../src/mock';
import { Composer, type ComposerProps } from '../../src/pages/chat/Composer';
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

/** Picker answers `picks` in turn; `made` holds each `POST /agent/scopes` body. */
function bridge(picks: PickedHandle[]) {
  const made: unknown[] = [];
  const routes: MockRoute[] = [
    { method: 'POST', path: '/agent/scopes', handler: ({ body }): MockResponse => (made.push(body), { status: 201, body: { scope_id: `scope-${made.length}`, revision: 1, roots: [], files: [], output: { path: '/x' }, created_at: 0, expires_at: 1, revoked: false } }) },
  ];
  const base = createFakeBridge({ surface: 'main', still: true, routes });
  const pickFile = vi.fn(async () => picks.shift() ?? null);
  window.agenticComplex = { ...base, files: { ...base.files, pickFile } };
  return { made, pickFile };
}

async function attach() {
  fireEvent.click(screen.getByRole('button', { name: '附加' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '添加文件或图片' }));
}

describe('chat composer keys', () => {
  it('Enter sends, and the placeholder speaks to her', async () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend })} />);
    expect(box().placeholder).toBe('对陈千语说…');
    type('在吗');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenLastCalledWith('在吗', { look: false, no_memory: false });
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('Shift+Enter does not send', () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend })} />);
    type('第一行');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter while the input method composes does not send', () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend })} />);
    type('zai');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('chat composer tray', () => {
  it('a picked file sits in the tray and goes out with the line; the page makes the scope', async () => {
    const b = bridge([{ handle: 'h-1', displayName: '销量.csv' }, { handle: 'h-2', displayName: '场地.png' }]);
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend })} />);
    await attach();
    expect(await screen.findByText('销量.csv')).toBeTruthy();
    await attach();
    expect(await screen.findByText('场地.png')).toBeTruthy();
    expect(b.pickFile).toHaveBeenCalledWith({ purpose: 'scope_file' });
    type('汇总一下');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(b.made).toEqual([]);
    expect(onSend).toHaveBeenLastCalledWith('汇总一下', { look: false, no_memory: false, files: [{ handle: 'h-1', displayName: '销量.csv' }, { handle: 'h-2', displayName: '场地.png' }] });
    await waitFor(() => expect(screen.queryByText('销量.csv')).toBeNull());
  });

  it('移除 takes a file out of the tray and out of the send', async () => {
    const b = bridge([{ handle: 'h-1', displayName: '销量.csv' }]);
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend })} />);
    await attach();
    fireEvent.click(await screen.findByRole('button', { name: '移除 销量.csv' }));
    expect(screen.queryByText('销量.csv')).toBeNull();
    type('不带了');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenLastCalledWith('不带了', { look: false, no_memory: false });
    expect(b.made).toEqual([]);
  });

  it('看一眼屏幕 and 这句不记 show in the tray and go out with the text', () => {
    const onSend = vi.fn(async () => 'sent' as const);
    render(<Composer {...props({ onSend })} />);
    fireEvent.click(screen.getByRole('button', { name: '附加' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '让她看一眼屏幕' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '这句不记' }));
    expect(screen.getByRole('button', { name: '不看屏幕' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消这句不记' }));
    type('看下这个');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenLastCalledWith('看下这个', { look: true, no_memory: false });
  });
});

describe('chat composer quote', () => {
  it('shows the quote, sends it as quote_turn with the plain text, and clears it', async () => {
    const onSend = vi.fn(async () => 'sent' as const);
    const onClearQuote = vi.fn();
    render(<Composer {...props({ onSend, onClearQuote, quote: { text: '周三下午三点\n三号训练场', turn_id: 'tr7', part: 'reply' } })} />);
    expect(screen.getByText(/周三下午三点/)).toBeTruthy();
    type('好的');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenLastCalledWith('好的', { look: false, no_memory: false, quote_turn: { turn_id: 'tr7', part: 'reply' } });
    await waitFor(() => expect(onClearQuote).toHaveBeenCalled());
  });

  it('× removes the quote', () => {
    const onClearQuote = vi.fn();
    render(<Composer {...props({ onClearQuote, quote: { text: '周三下午三点', turn_id: 'tr7', part: 'user' } })} />);
    fireEvent.click(screen.getByRole('button', { name: '不引用' }));
    expect(onClearQuote).toHaveBeenCalled();
  });
});

describe('chat composer drafts', () => {
  it('each topic keeps its own draft', () => {
    const { rerender } = render(<Composer {...props({ topicId: 'draft-a' })} />);
    type('给 A 的');
    rerender(<Composer {...props({ topicId: 'draft-b' })} />);
    expect(box().value).toBe('');
    type('给 B 的');
    rerender(<Composer {...props({ topicId: 'draft-a' })} />);
    expect(box().value).toBe('给 A 的');
    rerender(<Composer {...props({ topicId: 'draft-b' })} />);
    expect(box().value).toBe('给 B 的');
  });
});

describe('chat composer kernel', () => {
  it('a kernel that is not ready offers settings, not a switch, and leaves the input usable', async () => {
    render(<Composer {...props({ kernel: { id: 'codex', name: 'Codex', available: false, reason: null } as ComposerProps['kernel'] })} />);
    await act(async () => {});
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('[data-stub="KernelChain"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /切换|改用/ })).toBeNull();
    expect(screen.getByRole('link', { name: '设置 › 角色内核' }).getAttribute('href')).toBe('#/settings?group=kernel');
    expect(box().disabled).toBe(false);
  });
});

describe('chat composer: pasted and dropped files', () => {
  function adopting() {
    const base = createFakeBridge({ surface: 'main', still: true });
    const adoptPasted = vi.fn(async (items: Array<{ type: string; data: ArrayBuffer }>) =>
      items.map((it, i) => ({ handle: `P${i}`, displayName: `pasted-${i}.png`, size: it.data.byteLength })));
    const adoptDropped = vi.fn(async (files: File[]) => files.map((f, i) => ({ handle: `D${i}`, displayName: f.name, size: f.size })));
    window.agenticComplex = { ...base, files: { ...base.files, adoptPasted, adoptDropped } };
    return { adoptPasted, adoptDropped };
  }

  it('a pasted image goes to the shell as bytes and lands in the tray', async () => {
    const { adoptPasted } = adopting();
    render(<Composer {...props()} />);
    const png = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    fireEvent.paste(box(), { clipboardData: { files: [png], getData: () => '' } });
    await waitFor(() => expect(screen.getByText('pasted-0.png')).toBeTruthy());
    expect(adoptPasted).toHaveBeenCalledTimes(1);
    expect(adoptPasted.mock.calls[0]![0][0]!.type).toBe('image/png');
  });

  it('removing a file from the tray gives its handle back to the shell', async () => {
    const { adoptPasted } = adopting();
    const release = vi.fn(async () => undefined);
    window.agenticComplex = { ...window.agenticComplex!, files: { ...window.agenticComplex!.files, adoptPasted, release } };
    render(<Composer {...props()} />);
    fireEvent.paste(box(), { clipboardData: { files: [new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })], getData: () => '' } });
    await waitFor(() => expect(screen.getByText('pasted-0.png')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '移除 pasted-0.png' }));
    expect(screen.queryByText('pasted-0.png')).toBeNull();
    expect(release).toHaveBeenCalledWith('P0');
  });

  it('files dropped on the page land in the tray through adoptDropped', async () => {
    const { adoptDropped } = adopting();
    const doc = new File(['x'], '名单.xlsx');
    render(<Composer {...props({ dropped: { files: [doc], topic: null } })} />);
    await waitFor(() => expect(screen.getByText('名单.xlsx')).toBeTruthy());
    expect(adoptDropped).toHaveBeenCalledWith([doc]);
  });

  it('a drop the shell takes none of says how many were left out', async () => {
    const base = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = { ...base, files: { ...base.files, adoptDropped: async () => [] } };
    render(<Composer {...props({ dropped: { files: [new File(['x'], 'a.exe')], topic: null } })} />);
    await waitFor(() => expect(screen.getByText('1 个文件没带上')).toBeTruthy());
  });
});

describe('chat composer prewarm', () => {
  it('warms the quick session once typing pauses, not on each key', async () => {
    vi.useFakeTimers();
    try {
      let warmed = 0;
      const routes: MockRoute[] = [{ method: 'POST', path: '/chat/prewarm', handler: () => (warmed++, { status: 200, body: { ready: true } }) }];
      window.agenticComplex = createFakeBridge({ surface: 'main', still: true, routes });
      render(<Composer {...props()} />);
      type('早');
      await act(() => vi.advanceTimersByTimeAsync(300));
      type('早上好');
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(warmed).toBe(0);
      await act(() => vi.advanceTimersByTimeAsync(400));
      expect(warmed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
