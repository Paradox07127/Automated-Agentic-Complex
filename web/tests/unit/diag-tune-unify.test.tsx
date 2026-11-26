// 诊断和调参照全站规格：页签图标、DeviceRow 直接带落点属性、阈值刻度、参考线、ⓘ、DEV 标、窄宽度的紧凑读数板。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { RENDER_STATS } from '../../src/mock/fixtures';
import { DiagPage } from '../../src/pages/diag/Page';
import { Processes } from '../../src/pages/diag/Processes';
import { Resources } from '../../src/pages/diag/Resources';
import { processesOf } from '../../src/pages/diag/status';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(component: RouteComponent, search: string) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const noop = () => {};
const head = (title: string) => [...document.querySelectorAll<HTMLElement>('[data-stub="SecHead"]')].find((h) => h.querySelector('h3')?.textContent === title) ?? null;
/** The ⓘ sits right after the title (SecHead `info`), not in the right slot. */
const infoAfterTitle = (title: string) => head(title)?.querySelector('h3')?.nextElementSibling?.getAttribute('data-stub') === 'InfoTip';

describe('diag', () => {
  it('the five 现在 tabs carry the diag icons, then the 回看 group opens after a gap', async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    mount(DiagPage, '');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(9));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.slice(0, 5).map((t) => t.querySelector('[data-stub="Icon"]')?.getAttribute('data-icon'))).toEqual(['d-overview', 'd-proc', 'd-render', 'd-flow', 'd-state']);
    expect(tabs.map((t) => t.hasAttribute('data-gap'))).toEqual([false, false, false, false, false, true, false, false, false]);
  });

  it('总览: the landing target and row key sit on DeviceRow itself', async () => {
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
    mount(DiagPage, '');
    const row = await waitFor(() => document.querySelector<HTMLElement>('[data-row="agentd"]') ?? Promise.reject(new Error('no row')));
    expect(row.getAttribute('data-stub')).toBe('DeviceRow');
    expect(row.getAttribute('data-nav-target')).toBe('proc-agentd');
  });

  it('进程: the memory meter ticks the attention line; the curve draws 注意 and 过高 as limits; the note is an ⓘ', () => {
    const rows = processesOf({ agentd: { state: 'running', pid: 1, cpuPercent: 3.4, memoryMB: 300 } }, 'connected');
    const samples = [0, 1000, 2000].map((at) => ({ at, cpu: { agentd: 3 }, mem: { agentd: 300 } }));
    render(<Processes rows={rows} error={null} onRetry={noop} samples={samples} now={2000} metric="mem" onMetric={noop} uptime={{}} agentdGone={false} actions={{}} highlight={null} onRestart={noop} onLogs={noop} />);
    const row = document.querySelector<HTMLElement>('[data-nav-target="proc-agentd"]')!;
    const tick = row.querySelector<HTMLElement>('[data-stub="LoadBar"] [data-threshold]');
    expect(tick?.style.left).toBe(`${Math.round((600 / 1024) * 100)}%`);
    expect([...row.querySelectorAll('[data-stub="LineChart"] [data-limit]')].map((g) => g.getAttribute('data-limit'))).toEqual(['warning', 'danger']);
    expect(row.querySelector('[data-stub="LineChart"] svg[role="img"]')!.getAttribute('aria-label')).toMatch(/注意线 .+；过高线 .+$/);
    expect(infoAfterTitle('进程')).toBe(true);
  });

  it('渲染: the frame-rate chart draws 目标 and 过低 as limits; the note is an ⓘ', () => {
    const samples = RENDER_STATS.slice(0, 20).map((s) => ({ ...s, suspended: false }));
    render(<Resources samples={samples} renderWhy="" details={null} onProc={noop} />);
    const fps = screen.getByRole('region', { name: '帧率' });
    expect([...fps.querySelectorAll('[data-limit] text')].map((t) => t.textContent)).toEqual(['目标 60', '过低 30']);
    expect([...fps.querySelectorAll('[data-limit]')].map((g) => g.getAttribute('data-limit'))).toEqual(['', 'danger']);
    expect(fps.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toMatch(/目标线 60 fps；过低线 30 fps$/);
    const ft = screen.getByRole('region', { name: '帧耗时' });
    expect([...ft.querySelectorAll('[data-limit]')].map((g) => g.getAttribute('data-limit'))).toEqual(['warning']);
    expect(ft.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toMatch(/预算线 [\d.]+ ms$/);
    expect(infoAfterTitle('帧')).toBe(true);
  });
});
