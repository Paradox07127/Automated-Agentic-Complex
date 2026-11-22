// Process CPU/memory, avatar.details, settings.onChange and the fake bridge's render readings.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AvatarDetails, AvatarStats, AgenticComplexBridge, SettingsChange } from '../../src/bridge/protocol';
import { HEALTH, RENDER_STATS } from '../../src/mock/fixtures';
import { detailRaw, detailSummary } from '../../src/pages/diag/avatarDetails';
import { DiagPage } from '../../src/pages/diag/Page';
import { Processes } from '../../src/pages/diag/Processes';
import { cpuText, memText } from '../../src/pages/diag/procText';
import { renderWhy } from '../../src/pages/diag/renderWhy';
import { Resources } from '../../src/pages/diag/Resources';
import { SettingsPage } from '../../src/pages/settings/Page';
import { processesOf } from '../../src/pages/diag/status';
import { TunePage } from '../../src/pages/tune/Page';

const SUSPENDED: AvatarDetails = {
  renderer: 'metal',
  build: '3f9c2a71d0b4e8c5',
  pipeline: {
    character: 'voice_a',
    appearance: 'default',
    fallbackRequested: 'summer',
    ssaa: 2,
    shadowResolution: 2048,
    outline: 'on',
    displayResolution: false,
    unsupported: ['ssaa'],
    fpsRequested: 60,
    fpsTarget: 60,
    suspended: 'screen_sleep',
    gpuAllocatedMB: 411.6,
    framesSubmitted: 9000,
    clip: null,
    error: 'shader cache miss',
  },
  placement: { x: 1520.4, y: 84, scale: 1.25 },
};

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function mountPage(component: () => ReactNode, search: string) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('fake bridge', () => {
  it('avatar.onStats sends the fixture minute (minus the suspended seconds) with their times; unsubscribing stops it', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const got: AvatarStats[] = [];
    bridge.avatar.onStats((s) => got.push(s));
    await Promise.resolve();
    const sent = RENDER_STATS.filter((s) => s.fps != null);
    expect(got.map((s) => s.at)).toEqual(sent.map((s) => s.at));
    expect(got.at(-1)).toMatchObject({ fps: 59, frameMsP95: 15.6, gpuMs: 6.1 });
    const late: AvatarStats[] = [];
    bridge.avatar.onStats((s) => late.push(s))();
    await Promise.resolve();
    expect(late).toEqual([]);
  });

  it('supervisor.state carries CPU and memory; avatar.details a pipeline', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const sup = await bridge.supervisor.state();
    expect(sup.avatar).toMatchObject({ cpuPercent: 21.6, memoryMB: 1210 });
    const details = await bridge.avatar.details();
    expect(details.renderer).toBe('metal');
    expect(details.pipeline?.suspended).toBeNull();
  });
});

describe('diag processes', () => {
  it('maps supervisor CPU and memory onto the rows and shows them as numbers', () => {
    const rows = processesOf(
      { agentd: { state: 'running', pid: 1, cpuPercent: 3.42, memoryMB: 168.4 }, avatar: { state: 'running', pid: 2, cpuPercent: null, memoryMB: 1210 } },
      'connected',
    );
    expect(rows.map((r) => [r.key, r.cpu_percent, r.memory_mb])).toEqual([
      ['agentd', 3.42, 168.4],
      ['avatar', null, 1210],
    ]);
    expect([cpuText(3.42), cpuText(21.6), cpuText(null)]).toEqual(['3.4%', '22%', '—']);
    expect([memText(168.4), memText(1210), memText(null)]).toEqual(['168 MB', '1.2 GB', '—']);
    const { container } = render(
      <Processes rows={rows} error={null} onRetry={() => {}} samples={[]} now={0} metric="cpu" onMetric={() => {}} uptime={{}} agentdGone={false} actions={{}} highlight={null} onRestart={() => {}} onLogs={() => {}} />,
    );
    const row = (key: string) => container.querySelector(`[data-nav-target="proc-${key}"]`)?.textContent;
    expect(row('agentd')).toMatch(/3\.4\s*%/);
    expect(row('agentd')).toContain('pid 1');
    expect(row('avatar')).toMatch(/1\.2\s*GB/);
  });
});

describe('avatar details', () => {
  it('summarises in three lines and folds the long values', () => {
    expect(detailSummary(SUSPENDED)).toEqual([
      '渲染器 Metal │ 构建 3f9c2a71',
      'voice_a │ default │ SSAA 2× │ 阴影 2048 │ 描边 on',
      '画面暂停中 │ 屏幕睡眠 │ 显存 412 MB',
    ]);
    const raw = detailRaw(SUSPENDED);
    expect(raw).toContain('3f9c2a71d0b4e8c5');
    expect(raw).toContain('voice_a │ default（summer 不可用）');
    expect(raw).toContain('SSAA 关');
    expect(raw).toContain('shader cache miss');
    expect(raw).toContain('1520, 84');
    expect(raw).toContain('1.25×');
    expect(raw).not.toMatch(/[{}"]/);
    expect(detailSummary({ renderer: null, build: null, pipeline: null, placement: null })).toEqual(['渲染器 未知 │ 构建 —']);
  });

  it('a suspended host explains the missing render data', () => {
    expect(renderWhy(true, HEALTH.avatar, SUSPENDED)).toBe('画面暂停中 │ 屏幕睡眠');
    expect(renderWhy(true, HEALTH.avatar, null)).toBe('宿主没有上报帧数据');
    expect(renderWhy(false, HEALTH.avatar, SUSPENDED)).toBe('这个窗口收不到角色的帧数据');
  });

  it('the host details sit under the charts with their raw text folded', async () => {
    const samples = RENDER_STATS.slice(0, 20).map((s) => ({ ...s, suspended: false }));
    render(<Resources samples={samples} renderWhy="" details={SUSPENDED} onProc={() => {}} />);
    const host = screen.getByRole('region', { name: '宿主详情' });
    expect(host.textContent).toContain('Metal');
    expect(host.textContent).toContain('3f9c2a71');
    expect(host.textContent).toContain('shader cache miss');
    expect(host.textContent).not.toContain('1520, 84');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /宿主详情原文/ })));
    expect(document.body.textContent).toContain('1520, 84');
  });

  it('the diag page without samples shows the details and the suspend reason', async () => {
    const fake = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = { ...fake, avatar: { ...fake.avatar, onStats: () => () => {}, details: async () => SUSPENDED } };
    await mountPage(DiagPage, '&tab=render');
    expect((await screen.findByRole('region', { name: '宿主详情' })).textContent).toContain('Metal');
    expect(screen.getByRole('region', { name: '帧率' }).textContent).toContain('画面暂停中 │ 屏幕睡眠');
  });

  it('the 调参 render load says 画面暂停中 when a suspended host sends no stats', async () => {
    const fake = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = { ...fake, avatar: { ...fake.avatar, onStats: () => () => {}, details: async () => SUSPENDED } };
    await mountPage(TunePage, '&tab=render');
    expect(await screen.findByText(/画面暂停中 │ 屏幕睡眠/)).toBeTruthy();
    cleanup();
    window.agenticComplex = { ...fake, avatar: { ...fake.avatar, onStats: () => () => {} } };
    await mountPage(TunePage, '&tab=render');
    expect(await screen.findByText(/还没有收到宿主读数/)).toBeTruthy();
  });
});

describe('settings.onChange', () => {
  function installPush(): { bridge: AgenticComplexBridge; push: () => (c: SettingsChange) => void } {
    const fake = createFakeBridge({ surface: 'main', still: true });
    let push: (c: SettingsChange) => void = () => {};
    const bridge: AgenticComplexBridge = { ...fake, settings: { ...fake.settings, onChange: (cb) => ((push = cb), () => (push = () => {})) } };
    window.agenticComplex = bridge;
    return { bridge, push: () => push };
  }

  it('the settings page reads the native values again on a change pushed by the shell', async () => {
    const { bridge, push } = installPush();
    const read = vi.spyOn(bridge.settings, 'read');
    await mountPage(SettingsPage, '');
    await waitFor(() => expect(read).toHaveBeenCalled());
    const before = read.mock.calls.length;
    await act(async () => push()({ ids: ['beh.stay'] }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
  });

  it('the 调参 quality rows read the native values again when the menu flips beh.stay', async () => {
    const { bridge, push } = installPush();
    const read = vi.spyOn(bridge.settings, 'read');
    await mountPage(TunePage, '&tab=render');
    await waitFor(() => expect(read).toHaveBeenCalled());
    const before = read.mock.calls.length;
    await act(async () => push()({ ids: ['beh.stay'] }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
  });
});
