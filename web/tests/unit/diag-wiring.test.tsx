// Diag wiring: what the page asks agentd and the bridge for, and how agentd's shapes reach the screen.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, HttpMethod, ProcessState, StreamEvent } from '../../src/bridge/protocol';
import { isoWithOffset } from '../../src/domain/units';
import { NOW } from '../../src/mock/fixtures';
import { CAPABILITIES, DIAG_STATE } from '../../src/mock/diag';
import { GatePanel, gateHolds } from '../../src/pages/diag/GatePanel';
import { DiagPage } from '../../src/pages/diag/Page';
import { UsageCard } from '../../src/pages/diag/UsageCard';
import { turnsView } from '../../src/pages/diag/model';
import { issuesOf, parseChild } from '../../src/pages/diag/status';

type Call = [HttpMethod, string, unknown];

let calls: Call[];
let stream: { onEvent: (e: StreamEvent) => void; onReload: () => void } | null;
let actions: string[];
let restarts: string[];
let clipboard: string[];

function install(sup: Record<'agentd' | 'avatar', ProcessState> = { agentd: { state: 'running', pid: 4242 }, avatar: { state: 'running', pid: 4343 } }) {
  const fake = createFakeBridge({ surface: 'main', still: true });
  const bridge: AgenticComplexBridge = {
    ...fake,
    app: { ...fake.app, action: async (name) => void actions.push(name) },
    agentd: { ...fake.agentd, request: (m, p, b) => (calls.push([m, p, b]), fake.agentd.request(m, p, b)) },
    diag: {
      subscribe: (onEvent, onReload) => {
        stream = { onEvent, onReload };
        return () => void (stream = null);
      },
    },
    supervisor: { state: async () => sup, restart: async (t) => void restarts.push(t) },
    clipboard: { writeText: async (t) => void clipboard.push(t) },
  };
  window.agenticComplex = bridge;
}

async function mount(search = '') {
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const paths = () => calls.map(([m, p]) => `${m} ${p}`);
/** A process row once the page has read supervisor.state. */
const procRow = (key: string) => waitFor(() => document.querySelector<HTMLElement>(`[data-nav-target="proc-${key}"]`) ?? Promise.reject(new Error(`no row ${key}`)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  calls = [];
  stream = null;
  actions = [];
  restarts = [];
  clipboard = [];
  install();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.useRealTimers();
});

describe('diag page', () => {
  it('reads /diag/state, /capabilities and /character/runtime with GET and no body, and no removed route', async () => {
    await mount();
    await procRow('agentd');
    expect(calls).toEqual(expect.arrayContaining([['GET', '/diag/state', undefined], ['GET', '/capabilities', undefined], ['GET', '/character/runtime', undefined]]));
    expect(paths().filter((p) => /\/diag\/(logs|turns|records|voice)|\/trace\/export/.test(p))).toEqual([]);
    // 日志 is a 回看 tab, after the gap.
    expect(screen.getAllByRole('tab').findIndex((t) => t.hasAttribute('data-gap'))).toBeLessThan(screen.getAllByRole('tab').findIndex((t) => t.title === '日志'));
  });

  it('shows supervisor.state per process and the voice row from connections.tts', async () => {
    await mount();
    expect((await procRow('agentd')).textContent).toMatch(/4242.*运行中/);
    expect((await procRow('avatar')).textContent).toMatch(/4343.*运行中/);
    await waitFor(async () => expect((await procRow('voice')).textContent).toMatch(/连不上.*连接断开/));
  });

  it('turns a supervisor backoff(8) into the row and link reading', async () => {
    install({ agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'backoff(8)', pid: null, backoff: 8 } });
    await mount();
    const row = await procRow('avatar');
    await within(row).findByText(/秒后自动重启/);
    expect(row.textContent).toMatch(/重启中.*8 秒后自动重启/);
  });

  it('reads the seconds from supervisor.state `backoff`, not from the state text', async () => {
    install({ agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'backoff(8)', pid: null, backoff: 30 } });
    await mount();
    const row = await procRow('avatar');
    await within(row).findByText(/秒后自动重启/);
    expect(row.textContent).toContain('30 秒后自动重启');
  });

  it('puts a degraded voice on its row with the way to its setting, leaving sharing turned off out', async () => {
    await mount();
    const row = await procRow('voice');
    expect(within(row).getByRole('button', { name: '设置 › 说话' })).toBeTruthy();
    expect(screen.queryByText(/共享截图/)).toBeNull();
  });

  it('without screen recording the bar says observation reads window text only', async () => {
    const base = window.agenticComplex!;
    window.agenticComplex = { ...base, permissions: { ...base.permissions, status: async () => ({ ...(await base.permissions.status()), screenRecording: 'denied' }) } };
    await mount();
    const bar = (await screen.findByText(/屏幕录制没有授权/)).closest('[role="alert"]') as HTMLElement;
    expect(bar.textContent).toContain('观察只读取窗口文字，不截图');
    expect(within(bar).getByRole('button', { name: '前往设置' })).toBeTruthy();
  });

  it('a diag stream `state` replaces the snapshot without another request', async () => {
    await mount();
    const gate = await procRow('gate');
    const lim = DIAG_STATE.gate.daily_limit;
    await waitFor(() => expect(gate.textContent).toContain(`${DIAG_STATE.gate.today}/${lim}`));
    const before = calls.filter(([, p]) => p === '/diag/state').length;
    const next = { ...DIAG_STATE, gate: { ...DIAG_STATE.gate, today: lim - 1 } };
    act(() => stream?.onEvent({ event: 'state', id: 'b-2', data: JSON.stringify(next) }));
    await waitFor(() => expect(gate.textContent).toContain(`${lim - 1}/${lim}`));
    expect(calls.filter(([, p]) => p === '/diag/state').length).toBe(before);
  });

  it('a stream reload reads /diag/state again', async () => {
    await mount();
    await procRow('agentd');
    const before = calls.filter(([, p]) => p === '/diag/state').length;
    act(() => stream?.onReload());
    await waitFor(() => expect(calls.filter(([, p]) => p === '/diag/state').length).toBe(before + 1));
  });

  it('pausing drops the diag subscription', async () => {
    await mount();
    await procRow('agentd');
    expect(stream).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(stream).toBeNull();
    expect(screen.getByText(/已暂停/)).toBeTruthy();
  });

  it('copies diagnostics through app.action, not the clipboard, and restarts through supervisor.restart', async () => {
    await mount('&tab=proc');
    const row = await procRow('avatar');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' })));
    expect(actions).toEqual(['copy_diagnostics']);
    expect(clipboard).toEqual([]);
    fireEvent.click(within(row).getByRole('button', { name: '重启' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重启角色' })));
    expect(restarts).toEqual(['avatar']);
    // 日志 opens that process's source on 诊断 › 日志; 在 Finder 中显示 lives only there.
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: '日志' })));
    expect(actions).toEqual(['copy_diagnostics']);
    expect(window.location.hash).toMatch(/^#\/diag\?tab=logs&src=avatar/);
  });

  it('without render samples the frame plate says why', async () => {
    const base = window.agenticComplex!;
    const details = async () => ({ renderer: null, build: null, pipeline: null, placement: null });
    window.agenticComplex = { ...base, avatar: { ...base.avatar, onStats: () => () => {}, details } };
    await mount('&tab=render');
    await waitFor(() => expect(screen.getByRole('region', { name: '帧率' }).textContent).toContain('宿主没有上报帧数据'));
    expect(screen.queryByRole('region', { name: '宿主详情' })).toBeNull();
  });

  it('reads the frame rate from avatar.onStats', async () => {
    const base = window.agenticComplex!;
    window.agenticComplex = { ...base, avatar: { ...base.avatar, onStats: (cb) => (cb({ fps: 60, frameMs: 10, cpuPercent: 20, frameMsP95: 12, gpuMs: 8 }), () => {}) } };
    await mount('&tab=render');
    await waitFor(() => expect(document.querySelector('[data-nav-target="diag-render"]')?.textContent).toMatch(/^60\s*fps/));
  });

  it('an offline /diag/state is 后台服务没有响应, not raw JSON', async () => {
    window.agenticComplex = {
      ...window.agenticComplex!,
      agentd: { ...window.agenticComplex!.agentd, request: async () => ({ status: 0, body: null, error: { code: 'offline' } }) },
    };
    await mount();
    const fail = (await screen.findByText('后台服务没有响应')).closest('[role="alert"]');
    expect(fail).not.toBeNull();
    expect(fail?.textContent).not.toMatch(/[{}]/);
    expect(screen.getAllByText(/已断开/).length).toBeGreaterThan(0);
  });
});

describe('diag turns', () => {
  it('reads /trace/turns since 24 h back with an offset ISO and limit 200', async () => {
    await mount('&tab=flow');
    const since = encodeURIComponent(isoWithOffset(NOW - 86_400_000));
    await waitFor(() => expect(calls).toEqual(expect.arrayContaining([['GET', `/trace/turns?since=${since}&limit=200`, undefined]])));
  });

  it('reads the last hour of /trace/decisions for the coding-tool lane and no memory runs', async () => {
    await mount('&tab=flow');
    const hour = encodeURIComponent(isoWithOffset(NOW - 3_600_000));
    await waitFor(() => expect(paths()).toContain(`GET /trace/decisions?since=${hour}&limit=100`));
    expect(paths().filter((p) => p.includes('/summary/runs') || p.includes('/memory/runs'))).toEqual([]);
    expect(document.querySelector('button[aria-label^="记忆提取 │ "]')?.getAttribute('aria-label')).toBe('记忆提取 │ 次数在记忆管线页');
  });

  it('a failed /trace/turns read says so in 管道, not 后台服务没有响应', async () => {
    const base = window.agenticComplex!;
    window.agenticComplex = {
      ...base,
      agentd: {
        ...base.agentd,
        request: async (m, p, b) => (p.startsWith('/trace/turns?') ? { status: 500, body: null } : base.agentd.request(m, p, b)),
      },
    };
    await mount('&tab=flow');
    await waitFor(() => expect(screen.getByRole('region', { name: '管道' }).textContent).toContain('读不到轮次：'));
    expect(document.body.textContent).not.toContain('后台服务没有响应');
  });

  it('a live input.received re-reads the turn list', async () => {
    await mount();
    await procRow('agentd');
    await waitFor(() => expect(calls.some(([, p]) => p.startsWith('/trace/turns?'))).toBe(true));
    const before = calls.filter(([, p]) => p.startsWith('/trace/turns?')).length;
    act(() => stream?.onEvent({ event: 'trace', id: 'b-3', data: JSON.stringify({ event_id: 'x', trace_id: 'new', turn_id: 'turn-new', kind: 'input.received', producer: 'agentd', status: 'ok', duration_ms: null, at: isoWithOffset(NOW), attrs: { source: 'text' } }) }));
    await waitFor(() => expect(calls.filter(([, p]) => p.startsWith('/trace/turns?')).length).toBe(before + 1));
  });
});

describe('diag model', () => {
  it('derives dots, hourly failures and truncation from /trace/turns rows', () => {
    const row = (id: string, at: number, result: string) => ({ trace_id: id, turn_id: `t-${id}`, source: 'text', head: null, len: null, producers: ['agentd'], started_at: isoWithOffset(at), result, duration_ms: 100 });
    const start = NOW - 3 * 3_600_000;
    const v = turnsView([row('a', NOW - 60_000, 'failed'), row('b', start + 1000, 'completed'), row('c', start + 2000, 'failed')], start, NOW, 3);
    expect(v.failures_per_hour).toEqual([1, 0, 1]);
    expect(v.dots.map((d) => d.id)).toEqual(['b', 'c', 'a']);
    expect(v.turns.map((t) => [t.id, t.result])).toEqual([['a', 'failed'], ['b', 'ok'], ['c', 'failed']]);
    expect(v.truncated).toBe(true);
  });

  it('keeps sharing turned off and a muted voice out of the issues', () => {
    expect(issuesOf({ ...CAPABILITIES, items: { voice: { state: 'degraded', reason: 'muted' }, share_page_text: { state: 'unavailable', reason: 'off' } } })).toEqual([]);
    expect(issuesOf(CAPABILITIES).map((i) => [i.id, i.to])).toEqual([['voice', { page: 'settings', group: 'speak', item: 'tts' }]]);
  });

  it('a configured quiet_hours list is not a hold; the panel notes it apart', () => {
    const gate = { ...DIAG_STATE.gate, quiet_hours: [22, 8] };
    expect(gateHolds(gate)).toEqual([]);
    render(<GatePanel cooldowns={[]} gate={gate} />);
    expect(screen.getAllByText(/^(开着|没在开会|没有)$/)).toHaveLength(4);
    expect(screen.getByText('免打扰时段').nextElementSibling?.textContent).toBe('已设');
  });

  it('draws today’s model calls by channel and by call', () => {
    const m = DIAG_STATE.budget.model!;
    const use = { ...m, calls: 3, input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 };
    const wire = { ...DIAG_STATE.budget, model: { ...m, by_channel: { anthropic_api: use, unknown: { ...use, calls: 0 } } } };
    const { container } = render(<UsageCard budget={wire} loading={false} />);
    expect(container.textContent).toContain('Anthropic');
    expect(container.textContent).not.toContain('未知渠道');
    expect(screen.getByRole('list', { name: '按调用次数' }).textContent).toContain('观察摘要96 次');
  });

  it('reads supervisor ChildState descriptions', () => {
    expect(parseChild('backoff(16)')).toEqual({ kind: 'backoff', backoff_s: 16 });
    expect(parseChild('failed(exit 3)')).toEqual({ kind: 'failed', reason: 'exit 3' });
    expect(parseChild('gpuHold')).toEqual({ kind: 'gpuHold' });
  });
});
