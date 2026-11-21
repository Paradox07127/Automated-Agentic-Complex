import { act as flush, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import type { AgentdResponse } from '../../src/bridge/protocol';
import type { StackCard } from '../../src/surfaces/stack/model';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// What was dropped on her shows as a 交给她 card; nothing is read until the user picks an action.

stubMatchMedia();
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = 1_800_000_000_000;
type DropCard = Extract<StackCard, { variant: 'drop' }>;

const FILES: DropCard = {
  id: 'drop-1',
  kind: 'notice',
  variant: 'drop',
  at: NOW,
  title: '交给她 · 3 项',
  truncated: false,
  items: [
    { kind: 'file', path: '/Users/me/Desktop/周报.md', name: '周报.md', handle: 'H:周报.md' },
    { kind: 'file', path: '/Users/me/Desktop/截图.png', name: '截图.png', handle: 'H:截图.png' },
    { kind: 'file', path: '/Users/me/notes.txt', name: 'notes.txt', handle: 'H:notes.txt' },
  ],
};

const TEXTS: DropCard = {
  ...FILES,
  id: 'drop-2',
  title: '交给她 · 2 项',
  items: [
    { kind: 'url', url: 'https://example.com/a' },
    { kind: 'text', text: '周五前交报销单' },
  ],
};

function mount(card: DropCard) {
  render(<StackCardView card={card} index={1} total={1} top now={NOW} act={() => {}} />);
  return document.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`)!;
}

/** agentd's replies by `METHOD path`; anything else is a 404. */
function agentd(replies: Record<string, AgentdResponse<unknown>>) {
  return vi
    .spyOn(getBridge().agentd, 'request')
    .mockImplementation(async (method, path) => replies[`${method} ${path}`] ?? { status: 404, body: null, error: { code: 'not_found' } });
}

const SCOPE = {
  status: 201,
  body: {
    scope_id: 's1',
    expires_at: NOW / 1000 + 86400,
    files: [{ path: '/Users/me/Desktop/周报.md' }, { path: '/Users/me/notes.txt' }],
    roots: [],
    unsupported: [{ path: '/Users/me/Desktop/截图.png', reason: 'unsupported_type' }],
  },
};

const marks = (el: HTMLElement) => within(el).getAllByRole('listitem').map((r) => r.textContent?.includes('暂不支持读取'));

describe('drop card', () => {
  it('lists exactly the dropped paths and marks none before agentd has said what it cannot read', () => {
    const request = agentd({});
    const el = mount(FILES);
    const rows = within(el).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('title'))).toEqual(FILES.items.map((i) => (i.kind === 'file' ? i.path : null)));
    expect(marks(el)).toEqual([false, false, false]);
    expect(request).not.toHaveBeenCalled();
  });

  it('offers 总结 for a pdf and a folder, sends both handles, and marks the one agentd cannot read', async () => {
    const request = agentd({
      'POST /agent/scopes': {
        status: 201,
        body: { scope_id: 's2', expires_at: NOW / 1000 + 86400, files: [], roots: [{ path: '/Users/me/资料' }], unsupported: [{ path: '/Users/me/a.pdf', reason: 'unsupported_type' }] },
      },
    });
    vi.spyOn(getBridge().desktop, 'say').mockResolvedValue({ ok: true });
    const el = mount({
      ...FILES,
      id: 'drop-pdf',
      items: [
        { kind: 'file', path: '/Users/me/a.pdf', name: 'a.pdf', handle: 'H:a.pdf' },
        { kind: 'file', path: '/Users/me/资料', name: '资料', handle: 'H:资料' },
      ],
    });
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '总结' })));
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: [{ handle: 'H:a.pdf' }, { handle: 'H:资料' }] });
    await waitFor(() => expect(marks(el)).toEqual([true, false]));
  });

  it('no_supported_files says she cannot read these, marks every file, and takes 总结, 问 and 建任务 away', async () => {
    agentd({ 'POST /agent/scopes': { status: 400, body: { error: 'no_supported_files' }, error: { code: 'no_supported_files' } } });
    const el = mount(FILES);
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '总结' })));
    expect(await within(el).findByText('这些她还读不了')).toBeTruthy();
    expect(marks(el)).toEqual([true, true, true]);
    for (const name of ['总结', '问', '建任务']) expect(within(el).queryByRole('button', { name })).toBeNull();
  });

  it('总结 creates a scope of exactly those files, then asks her with it', async () => {
    const request = agentd({ 'POST /agent/scopes': SCOPE });
    const say = vi.spyOn(getBridge().desktop, 'say').mockResolvedValue({ ok: true });
    const el = mount(FILES);
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '总结' })));
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes', { files: FILES.items.map((i) => i.kind === 'file' && { handle: i.handle }) });
    expect(say).toHaveBeenCalledWith({ text: '总结这些文件', attachWindow: false, noMemory: false, scopeId: 's1' });
    expect(request.mock.invocationCallOrder[0]!).toBeLessThan(say.mock.invocationCallOrder[0]!);
    expect(await within(el).findByText(/^可读这 2 个文件/)).toBeTruthy();
  });

  it('撤销 revokes the scope and the card keeps saying so', async () => {
    const request = agentd({ 'POST /agent/scopes': SCOPE, 'POST /agent/scopes/s1/revoke': { status: 200, body: { revoked: true } } });
    vi.spyOn(getBridge().desktop, 'say').mockResolvedValue({ ok: true });
    const el = mount(FILES);
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '总结' })));
    await flush(async () => fireEvent.click(await within(el).findByRole('button', { name: '撤销' })));
    expect(request).toHaveBeenCalledWith('POST', '/agent/scopes/s1/revoke', {});
    expect(await within(el).findByText('已撤销读取授权')).toBeTruthy();
  });

  it('建任务 queues a job on the scope and shows a kernel 503 in words', async () => {
    const request = agentd({
      'POST /agent/scopes': SCOPE,
      'POST /agent/jobs': { status: 503, body: { error: 'native_login_required', runtime: 'codex' }, error: { code: 'native_login_required' } },
    });
    const el = mount(FILES);
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '建任务' })));
    expect(request).toHaveBeenCalledWith('POST', '/agent/jobs', expect.objectContaining({ scope_id: 's1' }));
    expect(await within(el).findByText(/还没有登录这个内核/)).toBeTruthy();
  });

  it('a text or link drop creates no scope; 记住 sends them as they are', async () => {
    const request = agentd({});
    const say = vi.spyOn(getBridge().desktop, 'say').mockResolvedValue({ ok: true });
    const el = mount(TEXTS);
    expect(within(el).queryByRole('button', { name: '总结' })).toBeNull();
    expect(within(el).queryByRole('button', { name: '建任务' })).toBeNull();
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '记住' })));
    expect(say).toHaveBeenCalledWith({ text: '记住 https://example.com/a\n周五前交报销单', attachWindow: false, noMemory: false });
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '提醒' })));
    await flush(async () => fireEvent.click(within(el).getByRole('button', { name: '1 小时后' })));
    expect(say).toHaveBeenLastCalledWith({ text: '提醒我1小时后看「https://example.com/a 等 2 项」', attachWindow: false, noMemory: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('a file drop offers no 记住', () => {
    mount(FILES);
    expect(screen.queryByRole('button', { name: '记住' })).toBeNull();
    return waitFor(() => expect(screen.getByText(/重置后台时删除/)).toBeTruthy());
  });
});
