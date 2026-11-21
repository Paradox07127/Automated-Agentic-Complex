// 观察简报：设置 › 隐私 › 观察的每日 / 每周开关，「简报」区块（今天页一句话日报的回退详情）的列表、打开和不再显示。
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationBriefsResponse } from '../../src/bridge/agentd-routes.generated';
import { createFakeBridge } from '../../src/bridge/fake';
import type { StreamEvent } from '../../src/bridge/protocol';
import { routes as observeRoutes } from '../../src/mock/observe';
import { NOW, PERMISSIONS } from '../../src/mock/fixtures';
import { demoNative } from '../../src/mock/settings';
import type { MockRoute } from '../../src/mock/types';
import { BriefHealth } from '../../src/pages/observe/BriefHealth';
import { BriefsSec } from '../../src/pages/observe/BriefsSec';
import { SettingsCtx, type SettingsCtxValue } from '../../src/pages/settings/ctx';
import { diagView } from '../../src/pages/settings/diag';
import { PrivacyGroup } from '../../src/pages/settings/groups/Privacy';
import { useSettingsModel } from '../../src/pages/settings/model';
import type { Native } from '../../src/pages/settings/native';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so each group shows all its rows.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

function install(routes: MockRoute[] = []) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const bridge = createFakeBridge({ surface: 'main', still: true, routes });
  window.agenticComplex = bridge;
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(bridge.diag, 'subscribe').mockImplementation(() => () => {});
  return vi.spyOn(bridge.agentd, 'request');
}

type Spy = ReturnType<typeof install>;
const sent = (spy: Spy, method: string, path: string) => spy.mock.calls.filter(([m, p]) => m === method && p === path);

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Harness({ children, native, agentdOff = false }: { children: ReactNode; native: Native; agentdOff?: boolean }) {
  const model = useSettingsModel({}, { native });
  const ctx: SettingsCtxValue = {
    model,
    ro: false,
    agentdOff,
    hl: null,
    demo: null,
    item: null,
    caps: window.agenticComplex!.capabilities,
    native,
    runtime: null,
    runtimeChecking: false,
    recheckRuntime: async () => null,
    models: null,
    diag: diagView(null),
    blacklist: null,
    scopes: [],
    runs: [],
    reload: () => {},
    perms: PERMISSIONS,
    recheckPerms: async () => 'denied',
    goRow: () => {},
    goPage: () => {},
  };
  return <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>;
}

function mountObserve() {
  const root = createRootRoute({
    component: () => (
      <>
        <BriefsSec no="01" />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('settings › 隐私 › 观察 › 简报', () => {
  it('shows the daily and weekly switches from GET settings and posts only the changed key', async () => {
    const spy = install();
    const native = await demoNative(null);
    render(
      <Harness native={native}>
        <PrivacyGroup />
      </Harness>,
    );
    const daily = await screen.findByRole('switch', { name: '每日简报' });
    expect(daily.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: '每周简报' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(daily));
    await waitFor(() => expect(sent(spy, 'POST', '/observation/briefs/settings')).toEqual([['POST', '/observation/briefs/settings', { daily: false }]]));
    await waitFor(() => expect(screen.getByRole('switch', { name: '每日简报' }).getAttribute('aria-checked')).toBe('false'));
  });

  it('turns the switches read-only while agentd is down', async () => {
    install();
    const native = await demoNative(null);
    render(
      <Harness native={native} agentdOff>
        <PrivacyGroup />
      </Harness>,
    );
    const weekly = await screen.findByRole('switch', { name: '每周简报' });
    expect(weekly.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('简报 section', () => {
  it('lists the reports newest first and opens one through GET /observation/briefs/:id', async () => {
    const spy = install();
    mountObserve();
    const sec = await screen.findByRole('region', { name: '简报' });
    const rows = await within(sec).findAllByRole('button', { name: /^(日报|周报) │ / });
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('日报'), expect.stringContaining('周报')]);
    fireEvent.click(rows[0]!);
    const sheet = await screen.findByRole('dialog', { name: '简报' });
    expect(await within(sheet).findByText('在改预算报告')).toBeTruthy();
    expect(within(sheet).getByText('改进：先定模板')).toBeTruthy();
    expect(within(sheet).getAllByText(/预算报告/).length).toBeGreaterThan(1);
    expect(sent(spy, 'GET', '/observation/briefs/brief-060021117a99a52a5f7164e80ab20970')).toHaveLength(1);
  });

  it('「不再显示」 sends DELETE and drops the brief from the list', async () => {
    const spy = install();
    mountObserve();
    const sec = await screen.findByRole('region', { name: '简报' });
    const rows = await within(sec).findAllByRole('button', { name: /^(日报|周报) │ / });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    const sheet = await screen.findByRole('dialog', { name: '简报' });
    await act(async () => fireEvent.click(await within(sheet).findByRole('button', { name: '不再显示' })));
    await waitFor(() => expect(sent(spy, 'DELETE', '/observation/briefs/brief-7b1d1f6f52c64a8f9e0d3c2b1a090807')).toHaveLength(1));
    await waitFor(() => expect(within(sec).getAllByRole('button', { name: /^(日报|周报) │ / })).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: '简报' })).toBeNull();
  });

  it('「现在生成」 posts a daily request and reads brief_busy as a sentence', async () => {
    const spy = install([{ method: 'POST', path: '/observation/briefs', handler: () => ({ status: 409, body: { error: 'brief_busy' } }) }]);
    mountObserve();
    const sec = await screen.findByRole('region', { name: '简报' });
    await act(async () => fireEvent.click(within(sec).getByRole('button', { name: '现在生成' })));
    expect(sent(spy, 'POST', '/observation/briefs')).toEqual([['POST', '/observation/briefs', { period: 'daily', retry: true }]]);
    expect(await screen.findByText(/已有一份简报正在生成/)).toBeTruthy();
  });

  it('rereads the list when agentd publishes the brief it finished writing', async () => {
    const base = observeRoutes.find((r) => r.method === 'GET' && r.path === '/observation/briefs')!;
    let written = false;
    const spy = install([
      {
        method: 'GET',
        path: '/observation/briefs',
        handler: (req) => {
          const r = base.handler(req) as { status: number; body: ObservationBriefsResponse };
          if (!written) return r;
          const first = r.body.reports[0]!;
          return { ...r, body: { ...r.body, reports: [{ ...first, id: 'brief-9d8c7b6a5f4e3d2c1b0a998877665544', date: '2026-10-30', start: first.start + 864e5, end: first.end + 864e5 }, ...r.body.reports] } };
        },
      },
    ]);
    const subs: Array<(e: StreamEvent) => void> = [];
    vi.spyOn(window.agenticComplex!.feed, 'subscribe').mockImplementation((on) => {
      subs.push(on);
      return () => {};
    });
    mountObserve();
    const sec = await screen.findByRole('region', { name: '简报' });
    expect(await within(sec).findAllByRole('button', { name: /^(日报|周报) │ / })).toHaveLength(2);
    await act(async () => fireEvent.click(within(sec).getByRole('button', { name: '现在生成' })));
    await waitFor(() => expect(sent(spy, 'POST', '/observation/briefs')).toHaveLength(1));
    written = true;
    const done: StreamEvent = { event: 'observation_brief', id: null, data: JSON.stringify({ id: 'brief-9d8c7b6a5f4e3d2c1b0a998877665544', period: 'daily', date: '2026-10-30', state: 'completed' }) };
    act(() => subs.forEach((on) => on(done)));
    await waitFor(() => expect(within(sec).getAllByRole('button', { name: /^(日报|周报) │ / })).toHaveLength(3));
  });
});

describe('简报生成状态', () => {
  const attempt = (id: string, period: string, state: string): ObservationBriefsResponse['attempts'][number] => ({
    id, state, period, date: '2026-10-29', timezone: 'Asia/Shanghai', start: 0, end: 0, updated_at: 0, attempts: 2,
    error_code: state === 'failed' ? 'timeout' : null, validation_path: null, retry_at: null, automatic_retry: false, can_retry: state === 'failed',
  });

  it('shows only a failed production, as an error bar with its retry', () => {
    render(<BriefHealth attempts={[attempt('a1', 'daily', 'completed'), attempt('a2', 'weekly', 'failed')]} onRetry={async () => {}} />);
    const bars = screen.getAllByRole('alert');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.textContent).toContain('周报 2026-10-29 │ 生成失败 │ 已尝试 2 次 │ 生成超时');
    expect(within(bars[0]!).getByRole('button', { name: '重试这一期' })).toBeTruthy();
  });

  it('renders nothing while every production succeeded', () => {
    const { container } = render(<BriefHealth attempts={[attempt('a1', 'daily', 'completed')]} onRetry={async () => {}} />);
    expect(container.textContent).toBe('');
  });
});
