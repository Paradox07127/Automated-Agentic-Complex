import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse, DesktopCommand } from '../../src/bridge/protocol';
import { BubbleRoot } from '../../src/surfaces/desktop/BubbleRoot';
import type { StackCard } from '../../src/surfaces/stack/model';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// What the selection hot key read shows in 快速输入 with six actions; nothing is sent before one is picked, and what
// is sent is the preview byte for byte. The drop card's 问 opens 快速输入 with its scope.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  delete document.documentElement.dataset.surface;
  window.location.hash = '';
});

const SELECTION: Extract<DesktopCommand, { kind: 'selection' }> = {
  kind: 'selection',
  source: 'selection',
  text: '  The quick  brown fox\n第二行，带空格 ',
  app: '备忘录',
  truncated: false,
};

/** The bubble with 快速输入 open as native opens it: whatever `first` is goes out just before the open. */
async function openInput(...first: DesktopCommand[]) {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  window.agenticComplex = bridge;
  const listeners = new Set<(c: DesktopCommand) => void>();
  vi.spyOn(bridge.desktop, 'onCommand').mockImplementation((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  });
  const say = vi.spyOn(bridge.desktop, 'say');
  const request = vi.spyOn(bridge.agentd, 'request');
  window.location.hash = '#/bubble?mode=input&still=1';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BubbleRoot />
    </QueryClientProvider>,
  );
  for (const c of [{ kind: 'close' } as const, ...first, { kind: 'open', mode: 'input' } as const])
    await flush(async () => listeners.forEach((cb) => cb(c)));
  const dialog = await screen.findByRole('dialog', { name: '快速输入' });
  return { bridge, say, request, dialog };
}

const attached = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>('[data-attachment-text]');

describe('selection actions', () => {
  it('a pushed selection shows the exact text, its source and size, and sends nothing', async () => {
    const { say, request, dialog } = await openInput(SELECTION);
    expect(attached(dialog)?.textContent).toBe(SELECTION.text);
    expect(dialog.textContent).toContain('选中文字 │ 备忘录');
    expect(dialog.textContent).toContain(`${[...SELECTION.text].length} 字`);
    for (const name of ['解释', '翻译', '改错', '问角色', '记住', '提醒']) within(dialog).getByRole('button', { name });
    expect(say).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('a cut clipboard read says so', async () => {
    const { dialog } = await openInput({ ...SELECTION, source: 'clipboard', app: null, truncated: true });
    expect(dialog.textContent).toContain('剪贴板');
    expect(dialog.textContent).toContain('只取了前 2000 字');
  });

  it('a region read is labeled 框选', async () => {
    const { dialog } = await openInput({ ...SELECTION, source: 'region', app: 'Safari' });
    expect(dialog.textContent).toContain('框选 │ Safari');
  });

  it('翻译 previews the line and sends exactly it without memory', async () => {
    const { say, dialog } = await openInput(SELECTION);
    fireEvent.click(within(dialog).getByRole('button', { name: '翻译' }));
    const preview = dialog.querySelector<HTMLElement>('[data-say-preview]')?.textContent ?? '';
    expect(preview.startsWith('翻译')).toBe(true);
    expect(preview.endsWith(`\n\n${SELECTION.text}`)).toBe(true);
    expect(say).not.toHaveBeenCalled();
    await flush(async () => fireEvent.click(within(dialog).getByRole('button', { name: '发送' })));
    expect(say).toHaveBeenCalledWith({ text: preview, attachWindow: false, noMemory: true, surface: 'quick_input' });
  });

  it('问角色, 记住 and 提醒 build their commands from the exact text', async () => {
    const { say, dialog } = await openInput(SELECTION);
    const pick = (name: string) => fireEvent.click(within(dialog).getByRole('button', { name }));
    const preview = () => dialog.querySelector<HTMLElement>('[data-say-preview]')?.textContent;
    pick('问角色');
    expect(preview()).toBe(SELECTION.text);
    pick('记住');
    expect(preview()).toBe(`记住 ${SELECTION.text}`);
    expect(dialog.textContent).toContain('她会记住这段文字');
    pick('提醒');
    expect(preview()).toBeUndefined();
    pick('1 小时');
    expect(preview()).toBe(`提醒我1小时后 ${SELECTION.text}`);
    await flush(async () => pick('发送'));
    expect(say).toHaveBeenCalledWith({ text: `提醒我1小时后 ${SELECTION.text}`, attachWindow: false, noMemory: false, surface: 'quick_input' });
  });

  it('a line typed with a selection attached sends the selection as its quote, with the app it came from', async () => {
    const { say, dialog } = await openInput(SELECTION);
    const box = within(dialog).getByRole('textbox');
    fireEvent.change(box, { target: { value: '这段什么意思' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({
      text: '这段什么意思',
      attachWindow: false,
      noMemory: false,
      surface: 'quick_input',
      quote: { text: SELECTION.text, app: '备忘录' },
    });
  });

  it('a clipboard read quotes no app, and ✕ sends the typed line without the quote', async () => {
    const quoted = await openInput({ ...SELECTION, source: 'clipboard', app: null });
    const box = within(quoted.dialog).getByRole('textbox');
    fireEvent.change(box, { target: { value: '翻一下' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(quoted.say).toHaveBeenCalledWith(expect.objectContaining({ quote: { text: SELECTION.text, app: null } }));
    cleanup();
    const dropped = await openInput(SELECTION);
    fireEvent.click(within(dropped.dialog).getByRole('button', { name: '不带这段文字' }));
    const again = within(dropped.dialog).getByRole('textbox');
    fireEvent.change(again, { target: { value: '你好' } });
    await flush(async () => fireEvent.keyDown(again, { key: 'Enter' }));
    expect(dropped.say).toHaveBeenCalledWith({ text: '你好', attachWindow: false, noMemory: false, surface: 'quick_input' });
  });

  it('✕ discards the selection and nothing is sent', async () => {
    const { say, request, dialog } = await openInput(SELECTION);
    fireEvent.click(within(dialog).getByRole('button', { name: '不带这段文字' }));
    expect(attached(dialog)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '翻译' })).toBeNull();
    expect(say).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('an open with nothing before it carries no attachment', async () => {
    const { dialog } = await openInput();
    expect(attached(dialog)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '翻译' })).toBeNull();
  });

  it('a refused read shows its message and no attachment', async () => {
    const { dialog } = await openInput({ kind: 'selectionRefused', message: '安全输入中，没有读取' });
    within(dialog).getByText('安全输入中，没有读取');
    expect(attached(dialog)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '翻译' })).toBeNull();
  });
});

describe('drop card 问', () => {
  const NOW = 1_800_000_000_000;
  const CARD: Extract<StackCard, { variant: 'drop' }> = {
    id: 'drop-1',
    kind: 'notice',
    variant: 'drop',
    at: NOW,
    title: '交给她 │ 2 项',
    truncated: false,
    items: [
      { kind: 'file', path: '/Users/me/Desktop/周报.md', name: '周报.md', handle: 'H:周报.md' },
      { kind: 'file', path: '/Users/me/notes.txt', name: 'notes.txt', handle: 'H:notes.txt' },
    ],
  };
  const SCOPE: AgentdResponse<unknown> = {
    status: 201,
    body: { scope_id: 's1', expires_at: NOW / 1000 + 86400, files: [{ path: '/Users/me/Desktop/周报.md' }, { path: '/Users/me/notes.txt' }], roots: [], unsupported: [] },
  };

  it('opens 快速输入 with the scope it created', async () => {
    const bridge = createFakeBridge({ surface: 'stack', still: true });
    window.agenticComplex = bridge;
    document.documentElement.dataset.surface = 'stack';
    const request = vi
      .spyOn(bridge.agentd, 'request')
      .mockImplementation(async (method, path) => (`${method} ${path}` === 'POST /agent/scopes' ? SCOPE : { status: 404, body: null, error: { code: 'not_found' } }));
    const action = vi.spyOn(bridge.desktop, 'action').mockResolvedValue();
    render(<StackCardView card={CARD} index={1} total={1} top now={NOW} act={() => {}} />);
    await flush(async () => fireEvent.click(screen.getByRole('button', { name: '问' })));
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: CARD.items.map((i) => i.kind === 'file' && { handle: i.handle }) });
    expect(action).toHaveBeenCalledWith('quickInput', JSON.stringify({ scopeId: 's1', files: 2 }));
  });

  it('a 快速输入 opened with a scope sends with it, and ✕ drops it', async () => {
    const { say, dialog } = await openInput({ kind: 'scope', scopeId: 's1', files: 2 });
    within(dialog).getByText('可读 2 个文件');
    const box = within(dialog).getByRole('textbox');
    fireEvent.change(box, { target: { value: '这两份讲了什么' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({ text: '这两份讲了什么', attachWindow: false, noMemory: false, scopeId: 's1', surface: 'quick_input' });
  });

  it('✕ on the scope sends without it', async () => {
    const { say, dialog } = await openInput({ kind: 'scope', scopeId: 's1', files: 2 });
    fireEvent.click(within(dialog).getByRole('button', { name: '不带这些文件' }));
    expect(within(dialog).queryByText('可读 2 个文件')).toBeNull();
    const box = within(dialog).getByRole('textbox');
    fireEvent.change(box, { target: { value: '你好' } });
    await flush(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(say).toHaveBeenCalledWith({ text: '你好', attachWindow: false, noMemory: false, surface: 'quick_input' });
  });
});
