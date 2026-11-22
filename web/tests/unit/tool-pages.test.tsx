// Diag's bottom bar and read-only process rows, and the trace turn list.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiagPage } from '../../src/pages/diag/Page';
import { Processes } from '../../src/pages/diag/Processes';
import { processesOf } from '../../src/pages/diag/status';
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

describe(' diag bottom bar', () => {
  it('diag has no tool bar: 暂停, 复制诊断信息 and 重启 sit at the bottom bar\'s right end', async () => {
    mount(DiagPage, '');
    const bar = await waitFor(() => document.querySelector<HTMLElement>('[data-bottom-zones]') ?? Promise.reject(new Error('no bar')));
    expect(document.querySelector('[data-toolbar]')).toBeNull();
    const acts = bar.lastElementChild as HTMLElement;
    expect(within(acts).getAllByRole('button').map((b) => b.textContent)).toEqual(['暂停', '复制诊断信息', '重启']);
  });
});

const SUP = { agentd: { state: 'running', pid: 1, cpuPercent: 3.42, memoryMB: 168 }, avatar: { state: 'stopped', pid: null } } as const;
const noop = () => {};

describe(' process rows', () => {
  it('are read-only: rows take no focus or selection, the state is a lamp', () => {
    const rows = processesOf(SUP, 'connected');
    render(
      <Processes rows={rows} error={null} onRetry={noop} samples={[]} now={0} metric="cpu" onMetric={noop} uptime={{}} agentdGone={false} actions={{}} highlight={null} onRestart={noop} onLogs={noop} />,
    );
    const row = document.querySelector<HTMLElement>('[data-nav-target="proc-agentd"]')!;
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.hasAttribute('aria-selected')).toBe(false);
    expect(within(row).getByText('运行中').closest('[data-stub="StatusLamp"]')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: '曲线' })).toBeTruthy();
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
