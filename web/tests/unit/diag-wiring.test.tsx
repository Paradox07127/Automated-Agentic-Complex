// Diag wiring: what the page asks agentd and the bridge for, and how agentd's shapes reach the screen.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, HttpMethod, ProcessState, StreamEvent } from '../../src/bridge/protocol';
import { isoWithOffset } from '../../src/domain/units';
import { NOW } from '../../src/mock/fixtures';
import { CAPABILITIES, DIAG_STATE, turnEvents } from '../../src/mock/diag';
import { pathFromEvents } from '../../src/pages/diag/flow';
import { GatePanel, gateHolds } from '../../src/pages/diag/GatePanel';
import { ObsPanel } from '../../src/pages/diag/ObsPanel';
import { DiagPage } from '../../src/pages/diag/Page';
import { Resources } from '../../src/pages/diag/Resources';
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
    expect(screen.queryByRole('tab', { name: '日志' })).toBeNull();
  });

  it('shows supervisor.state per process and the voice row from connections.tts', async () => {
    await mount();
    expect((await procRow('agentd')).textContent).toMatch(/4242.*运行中/);
    expect((await procRow('avatar')).textContent).toMatch(/4343.*运行中/);
    expect((await procRow('voice')).textContent).toContain('远端不通 │ 连接断开');
  });

  it('turns a supervisor backoff(8) into the row and link reading', async () => {
    install({ agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'backoff(8)', pid: null, backoff: 8 } });
    await mount();
    const row = await procRow('avatar');
    await within(row).findByText(/退避/);
    expect(row.textContent).toMatch(/重启中.*退避 8 秒后重试/);
    expect(screen.getByRole('button', { name: /桌面角色：断开，8 s 后重启/ })).toBeTruthy();
  });

  it('reads the seconds from supervisor.state `backoff`, not from the state text', async () => {
    install({ agentd: { state: 'running', pid: 1, backoff: null }, avatar: { state: 'backoff(8)', pid: null, backoff: 30 } });
    await mount();
    const row = await procRow('avatar');
    await within(row).findByText(/退避/);
    expect(row.textContent).toContain('退避 30 秒后重试');
    expect(screen.getByRole('button', { name: /桌面角色：断开，30 s 后重启/ })).toBeTruthy();
  });

  it('lists degraded /capabilities items as issues with their fix, leaving sharing turned off out', async () => {
    await mount();
    const issue = await screen.findByText(/语音受限/);
    expect(issue.closest('[role="status"]')?.textContent).toContain('连不上 TTS 服务');
    expect(within(issue.closest('[role="status"]') as HTMLElement).getByRole('button', { name: '前往设置' })).toBeTruthy();
    expect(screen.queryByText(/共享截图/)).toBeNull();
    expect(screen.getByText('观察只读取窗口文字，不截图')).toBeTruthy();
  });

  it('a diag stream `state` replaces the snapshot without another request', async () => {
    await mount();
    await screen.findByText(/\$0\.42/);
    const before = calls.filter(([, p]) => p === '/diag/state').length;
    const model = DIAG_STATE.budget.model!;
    const next = { ...DIAG_STATE, budget: { ...DIAG_STATE.budget, model: { ...model, cost_usd: 0.99 } } };
    act(() => stream?.onEvent({ event: 'state', id: 'b-2', data: JSON.stringify(next) }));
    expect(await screen.findByText(/\$0\.99/)).toBeTruthy();
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
    await mount();
    const row = await procRow('avatar');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' })));
    expect(actions).toEqual(['copy_diagnostics']);
    expect(clipboard).toEqual([]);
    fireEvent.click(within(row).getByRole('button', { name: '重启' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '重启角色' })));
    expect(restarts).toEqual(['avatar']);
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: '查看日志' })));
    expect(actions).toEqual(['copy_diagnostics', 'reveal_logs']);
  });

  it('without render samples the frame plate says why', async () => {
    const base = window.agenticComplex!;
    const details = async () => ({ renderer: null, build: null, pipeline: null, placement: null });
    window.agenticComplex = { ...base, avatar: { ...base.avatar, onStats: () => () => {}, details } };
    await mount();
    await procRow('agentd');
    const plate = document.querySelector('[data-nav-target="diag-render"]');
    expect(plate?.textContent).toContain('宿主没有上报帧数据');
    expect(screen.queryByRole('button', { name: /宿主详情/ })).toBeNull();
  });

  it('reads the frame rate from avatar.onStats', async () => {
    const base = window.agenticComplex!;
    window.agenticComplex = { ...base, avatar: { ...base.avatar, onStats: (cb) => (cb({ fps: 60, frameMs: 10, cpuPercent: 20, frameMsP95: 12, gpuMs: 8 }), () => {}) } };
    await mount();
    await waitFor(() => expect(document.querySelector('[data-nav-target="diag-render"]')?.textContent).toContain('60 fps'));
  });

  it('a recent observation opens GET /diag/observations/<id>: summary, field table, the description folded', async () => {
    Element.prototype.scrollIntoView = () => {};
    await mount('&item=state');
    fireEvent.click(await screen.findByRole('button', { name: '看这条观察：成功 │ 截图' }));
    await waitFor(() => expect(calls).toContainEqual(['GET', '/diag/observations/a2a2a2a2a2a2', undefined]));
    const box = await screen.findByRole('region', { name: '观察详情' });
    expect(await within(box).findByText('截图 │ 看到了 │ Xcode')).toBeTruthy();
    expect(within(box).getByText('读取时可用于上下文，最近一轮用了它')).toBeTruthy();
    expect(within(box).getByText('观察时间')).toBeTruthy();
    expect(within(box).getByText('14:29:12')).toBeTruthy();
    const fold = within(box).getByRole('button', { name: /视觉描述/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(box.textContent).not.toContain('reconnectDelay');
    fireEvent.click(fold);
    expect(box.textContent).toContain('reconnectDelay');
    fireEvent.click(within(box).getByRole('button', { name: '收起' }));
    expect(screen.queryByRole('region', { name: '观察详情' })).toBeNull();
  });

  it('obs=<id> in the link opens that observation under 内部状态', async () => {
    Element.prototype.scrollIntoView = () => {};
    await mount('&item=state&obs=a2a2a2a2a2a2');
    const box = await screen.findByRole('region', { name: '观察详情' });
    expect(await within(box).findByText('截图 │ 看到了 │ Xcode')).toBeTruthy();
    expect(calls).toContainEqual(['GET', '/diag/observations/a2a2a2a2a2a2', undefined]);
    expect(screen.getByRole('button', { name: '看这条观察：成功 │ 截图' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('an observation agentd no longer holds says so instead of raw JSON', async () => {
    Element.prototype.scrollIntoView = () => {};
    await mount('&item=state');
    const base = window.agenticComplex!;
    window.agenticComplex = { ...base, agentd: { ...base.agentd, request: async (m, p, b) => (p.startsWith('/diag/observations/') ? { status: 404, body: null, error: { code: 'observation_not_found' } } : base.agentd.request(m, p, b)) } };
    fireEvent.click(await screen.findByRole('button', { name: '看这条观察：成功 │ 截图' }));
    const box = await screen.findByRole('region', { name: '观察详情' });
    expect((await within(box).findByRole('alert')).textContent).toContain('这条观察已经不在后台内存里');
  });

  it.each([
    ['secure_input', '正在输入密码'],
    ['incognito', '无痕窗口'],
    ['capture_failed', '截图失败'],
    ['permission_denied', '没有截图权限'],
    ['window_gone', '窗口已关闭'],
    ['vision_error', '视觉模型出错'],
    ['policy_changed', '隐私设置变了'],
    ['turn_cancelled', '这一轮已取消'],
    ['deleted', '已删除'],
    ['something_new', '其他原因'],
  ])('an observation declined for %s gives the reason in Chinese', async (reason, text) => {
    Element.prototype.scrollIntoView = () => {};
    await mount('&item=state');
    const base = window.agenticComplex!;
    const body = { request_id: 'a2a2a2a2a2a2', mode: 'image', status: 'declined', reason, app: null, requested_at: isoWithOffset(NOW - 2000), observed_at: null, current: false, description: null, description_truncated: false, content_available: false, used_in_last_turn: null };
    window.agenticComplex = { ...base, agentd: { ...base.agentd, request: async (m, p, b) => (p.startsWith('/diag/observations/') ? { status: 200, body: body as never } : base.agentd.request(m, p, b)) } };
    fireEvent.click(await screen.findByRole('button', { name: '看这条观察：成功 │ 截图' }));
    const box = await screen.findByRole('region', { name: '观察详情' });
    expect(await within(box).findByText(text)).toBeTruthy();
    expect(box.textContent).not.toContain(reason);
  });

  it('an offline /diag/state is 后台服务无响应, not raw JSON', async () => {
    window.agenticComplex = {
      ...window.agenticComplex!,
      agentd: { ...window.agenticComplex!.agentd, request: async () => ({ status: 0, body: null, error: { code: 'offline' } }) },
    };
    await mount();
    const fail = (await screen.findByText(/后台服务无响应/)).closest('[role="alert"]');
    expect(fail).not.toBeNull();
    expect(fail?.textContent).not.toMatch(/[{}]/);
    expect(screen.getAllByText(/已断开/).length).toBeGreaterThan(0);
  });
});

describe('diag turns', () => {
  it('reads /trace/turns since 24 h back with an offset ISO and limit 200, then the selected trace', async () => {
    await mount('&sel=tr6');
    await screen.findByText('轮次详情');
    const since = encodeURIComponent(isoWithOffset(NOW - 86_400_000));
    await waitFor(() => expect(calls).toEqual(expect.arrayContaining([['GET', `/trace/turns?since=${since}&limit=200`, undefined], ['GET', '/trace/turns/tr6', undefined]])));
  });

  it('replays an interrupted turn up to the playback node', async () => {
    await mount('&sel=tr6');
    await screen.findByText('已回放');
    await waitFor(() => expect(document.querySelector('button[aria-label^="播放 │ "]')?.hasAttribute('data-lit')).toBe(true));
    expect(document.querySelector('button[aria-label^="动作 │ "]')?.hasAttribute('data-dim')).toBe(true);
  });

  it('a link by turn_id lands on the trace that holds it', async () => {
    await mount('&sel=tr8');
    expect((await screen.findAllByText('14:14:00')).length).toBeGreaterThan(0);
  });

  it('reads today’s /summary/runs and the last hour of /trace/decisions for the side lanes', async () => {
    await mount();
    await procRow('agentd');
    const hour = encodeURIComponent(isoWithOffset(NOW - 3_600_000));
    await waitFor(() => expect(paths()).toEqual(expect.arrayContaining(['GET /summary/runs?date=2026-10-29', `GET /trace/decisions?since=${hour}&limit=100`])));
    await waitFor(() => expect(document.querySelector('button[aria-label^="记忆提取 │ "]')?.getAttribute('aria-label')).toContain('近 1 小时 1 次 │ p50 5.4 s'));
  });

  it('a failed /trace/turns read shows the timeline error, not 后台服务无响应', async () => {
    const base = window.agenticComplex!;
    window.agenticComplex = {
      ...base,
      agentd: {
        ...base.agentd,
        request: async (m, p, b) => (p.startsWith('/trace/turns?') ? { status: 500, body: null } : base.agentd.request(m, p, b)),
      },
    };
    await mount();
    await procRow('agentd');
    await waitFor(() => expect(document.querySelector('section[aria-label="轮次时间轴"]')?.textContent).toContain('读取失败'));
    expect(document.body.textContent).not.toContain('后台服务无响应');
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

  it('replays only the nodes evidenced by failed or still-running turn events', () => {
    expect(pathFromEvents(turnEvents('tr5')!.events)).toEqual(['input', 'ctx', 'model']);
    expect(pathFromEvents(turnEvents('tr0')!.events)).toEqual(['input', 'ctx', 'model']);
    expect(pathFromEvents([])).toEqual([]);
  });

  it('keeps sharing turned off and a muted voice out of the issues', () => {
    expect(issuesOf({ ...CAPABILITIES, items: { voice: { state: 'degraded', reason: 'muted' }, share_page_text: { state: 'unavailable', reason: 'off' } } })).toEqual([]);
    expect(issuesOf(CAPABILITIES).map((i) => [i.id, i.to])).toEqual([['voice', { page: 'settings', group: 'speak', item: 'tts' }]]);
  });

  it('a configured quiet_hours list is not a hold; the panel notes it apart', () => {
    const gate = { ...DIAG_STATE.gate, quiet_hours: [22, 8] };
    expect(gateHolds(gate)).toEqual([]);
    render(<GatePanel cooldowns={[]} gate={gate} />);
    expect(screen.getByText('✓ 没有拦着的条件')).toBeTruthy();
    expect(screen.getByText('已设免打扰时段')).toBeTruthy();
  });

  it('puts the observation reason into the pending and recent hover text', () => {
    const o = { ...DIAG_STATE.observation, pending: [{ ...DIAG_STATE.observation.pending[0]!, reason: 'look' }] };
    const { container } = render(<ObsPanel observation={o} readAt={NOW} now={NOW} />);
    expect(container.querySelector('[title*="超时"]')?.getAttribute('title')).toBe('失败 │ 窗口文字 │ 超时');
    expect(container.querySelector('[title*="look"]')).toBeTruthy();
  });

  it('draws today’s usage by channel and by call, with the cost as a floor while calls are unpriced', () => {
    const m = DIAG_STATE.budget.model!;
    const use = { ...m, calls: 3, input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 };
    const wire = { ...DIAG_STATE.budget, model: { ...m, by_channel: { anthropic_api: use, unknown: { ...use, calls: 0 } } } };
    const { container } = render(<Resources samples={[]} renderWhy="" details={null} budget={wire} procHistory={null} procNow={[]} totals={null} st="ok" />);
    expect(container.textContent).toContain('Anthropic');
    expect(container.textContent).not.toContain('未知渠道');
    expect(screen.getByRole('list', { name: '按调用次数' }).textContent).toContain('观察摘要96 次');
    expect(container.textContent).toContain('≥ $0.42');
  });

  it('reads supervisor ChildState descriptions', () => {
    expect(parseChild('backoff(16)')).toEqual({ kind: 'backoff', backoff_s: 16 });
    expect(parseChild('failed(exit 3)')).toEqual({ kind: 'failed', reason: 'exit 3' });
    expect(parseChild('gpuHold')).toEqual({ kind: 'gpuHold' });
  });
});
