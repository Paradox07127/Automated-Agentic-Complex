// 运行记录 below 1200 px: a turn's detail opens in a right-hand drawer over the list instead of beside it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireTraceTurn } from '../../src/domain/wire';
import { DiagPage } from '../../src/pages/diag/Page';
import { buildTurn } from '../../src/pages/trace/steps';
import { TurnDetail } from '../../src/pages/trace/TurnDetail';
import { stubMatchMedia } from './mediaStub';
import { pluginsOn, pluginsReset } from './plugins';

const NARROW = '(max-width: 1199px)';

beforeEach(() => pluginsOn());
afterEach(() => {
  pluginsReset();
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function mount(search: string) {
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${/tab=/.test(search) ? '' : '&tab=turns'}${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe(' 运行记录 under 1200 px', () => {
  it('shows only the list; picking a turn opens its detail in a drawer, Esc closes it and the row stays picked', async () => {
    stubMatchMedia(new Set([NARROW]));
    mount('&demo=full');
    const list = await screen.findByRole('listbox', { name: '近 24 小时的轮次' });
    const rows = await within(list).findAllByRole('option');
    expect(screen.queryByRole('region', { name: '这一轮' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    const row = rows[1]!;
    fireEvent.click(row);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('region', { name: '这一轮' })).toBeTruthy();
    await waitFor(() => expect(row.getAttribute('aria-selected')).toBe('true'));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(within(list).getAllByRole('option')).toHaveLength(rows.length);
  });

  it('the drawer closes with its close key', async () => {
    stubMatchMedia(new Set([NARROW]));
    mount('&demo=full');
    const list = await screen.findByRole('listbox', { name: '近 24 小时的轮次' });
    fireEvent.click((await within(list).findAllByRole('option'))[0]!);
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: '收起这一轮' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a link to one turn opens it in the drawer', async () => {
    stubMatchMedia(new Set([NARROW]));
    mount('&demo=full&turn=tr7');
    const drawer = await screen.findByRole('dialog');
    await waitFor(() => expect(within(drawer).getByRole('region', { name: '这一轮' }).textContent).toContain('$0.013'));
  });

  it('at 1200 px and wider the detail stays beside the list', async () => {
    stubMatchMedia();
    mount('&demo=full');
    await screen.findByRole('listbox', { name: '近 24 小时的轮次' });
    expect(await screen.findByRole('region', { name: '这一轮' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe(' 运行记录 复制 JSON', () => {
  it('keeps no text: every {len, head} head is blank and error_message is gone', () => {
    const row: WireTraceTurn = { trace_id: 't1', turn_id: 'u1', source: 'text', head: null, len: 4, producers: ['agentd'], started_at: '2026-11-24T10:00:00.000Z',
      result: 'failed', duration_ms: 900 };
    const events = [
      { kind: 'input.received', status: 'ok', t_wall: '2026-11-24T10:00:00.000Z', attrs: { source: 'text', text: { len: 4, head: '你好世界' } }, text: { text: '你好世界' } },
      { kind: 'context.assembled', status: 'ok', t_wall: '2026-11-24T10:00:00.100Z', attrs: { items: [{ type: 'note', note: { len: 3, head: '小纸条' } }] } },
      { kind: 'turn.settled', status: 'failed', t_wall: '2026-11-24T10:00:00.900Z', attrs: { error_code: 'kernel_failed', error_message: '密钥过期了' } },
    ];
    const onCopy = vi.fn();
    render(
      <TurnDetail row={row} no={1} turn={buildTurn({ row, events })} st="ok" emptyText="" convTitle={null} related={[]} onRetry={() => {}} onOpenChat={null}
        onLogs={() => {}} onCopy={onCopy} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
    const [json, toast] = onCopy.mock.calls[0]! as [string, string];
    expect(toast).toBe('已复制这一轮的事件 JSON（不含原文）');
    for (const gone of ['你好世界', '小纸条', '密钥过期了', 'error_message']) expect(json).not.toContain(gone);
    const out = JSON.parse(json) as Array<{ attrs: Record<string, unknown> }>;
    expect(out[0]!.attrs.text).toEqual({ len: 4, head: '' });
    expect(out[2]!.attrs.error_code).toBe('kernel_failed');
  });
});

describe(' 运行记录 filters', () => {
  it('the source menu is a radio choice and marks its trigger when it narrows the list', async () => {
    stubMatchMedia();
    mount('&demo=full');
    await screen.findByRole('listbox', { name: '近 24 小时的轮次' });
    const trigger = screen.getByRole('button', { name: /^全部来源/ });
    fireEvent.click(trigger);
    const pick = screen.getByRole('menuitemradio', { name: '主动发起' });
    expect(screen.getByRole('menuitemradio', { name: '全部来源' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(pick);
    await waitFor(() => expect(screen.getByRole('button', { name: /^主动发起（已收窄）/ })).toBeTruthy());
  });

  it('Enter in the search opens the first matching turn; ⌘F focuses the search', async () => {
    stubMatchMedia(new Set([NARROW]));
    const router = mount('&demo=full');
    const list = await screen.findByRole('listbox', { name: '近 24 小时的轮次' });
    await within(list).findAllByRole('option');
    const search = screen.getByRole('textbox', { name: '找一轮' });
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: '2' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const want = within(list).getAllByRole('option')[0]!.getAttribute('data-turn');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ turn: want }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
