// The tool pages' filter bar, the read-only process table and the trace turn list.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Health } from '../../src/domain';
import { DiagPage } from '../../src/pages/diag/Page';
import { Processes } from '../../src/pages/diag/Processes';
import { processesOf } from '../../src/pages/diag/status';
import { ToolBar } from '../../src/pages/diag/ToolBar';
import { TracePage } from '../../src/pages/trace/Page';

afterEach(cleanup);

function mount(component: RouteComponent, search: string) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe(' tool bar', () => {
  it('puts the filters first, then the hatch band, then the main action last', () => {
    const { container } = render(
      <ToolBar action={<button type="button">新建</button>}>
        <button type="button">暂停</button>
      </ToolBar>,
    );
    const bar = container.querySelector('[data-toolbar]')!;
    const kids = [...bar.children];
    expect(kids.map((k) => k.textContent)).toEqual(['暂停', '', '新建']);
    expect(kids[1]?.getAttribute('aria-hidden')).toBe('true');
    expect(kids[2]?.hasAttribute('data-toolbar-action')).toBe(true);
  });

  it('is only the band when a page has no filters and no action', () => {
    const { container } = render(<ToolBar />);
    expect(container.querySelector('[data-toolbar]')?.children).toHaveLength(1);
  });

  it('diag: 暂停 is the filter, 复制诊断信息 and 重启 sit at the right end', async () => {
    mount(DiagPage, '');
    const bar = await waitFor(() => document.querySelector<HTMLElement>('[data-toolbar]') ?? Promise.reject(new Error('no bar')));
    const action = bar.querySelector<HTMLElement>('[data-toolbar-action]')!;
    expect(within(action).getByRole('button', { name: '复制诊断信息' })).toBeTruthy();
    expect(within(action).getByRole('button', { name: /重启/ })).toBeTruthy();
    expect(bar.firstElementChild?.textContent).toContain('暂停');
  });
});

const HEALTH = { voice: { state: 'ready' } } as unknown as Health;
const SUP = { agentd: { state: 'running', pid: 1, cpuPercent: 3.42, memoryMB: 168 }, avatar: { state: 'stopped', pid: null } } as const;
const noop = () => {};

describe(' process table', () => {
  it('is a read-only data table: column heads, rows that take no focus or selection', () => {
    const rows = processesOf(SUP, 'connected', HEALTH, null);
    render(<Processes q={{ status: 'success', data: rows }} uptime={{}} history={null} actions={{}} highlight={null} onRestart={noop} onLogs={noop} onVoice={noop} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', '', '运行时长', '内存', 'CPU', '']);
    const row = table.querySelector<HTMLElement>('tr[data-nav-target="proc-agentd"]')!;
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.hasAttribute('aria-selected')).toBe(false);
    expect(within(row).getByText('运行中').closest('[data-stub="StatusTag"]')).not.toBeNull();
  });
});

describe(' trace turn list', () => {
  it('lists turns as option rows with a state sign; pressing a row opens it', async () => {
    const router = mount(TracePage, '&demo=full');
    const list = await screen.findByRole('listbox', { name: '近 24 小时的轮次' });
    const rows = await within(list).findAllByRole('option');
    const last = rows[rows.length - 1]!;
    expect(last.querySelector('[data-sign] svg[data-shape]')).not.toBeNull();
    fireEvent.click(last);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ turn: last.getAttribute('data-turn') }));
    await waitFor(() => expect(last.getAttribute('aria-selected')).toBe('true'));
  });
});
