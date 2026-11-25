// Diag: five tabs — 总览 rows, 进程 curves, 渲染 frames, 管道 flow with hours and model calls, 状态 blocks.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { ProcessState, StreamEvent } from '../../src/bridge/protocol';
import type { Turn } from '../../src/domain';
import { isoWithOffset } from '../../src/domain/units';
import { DIAG_STATE, TRACE_TURNS } from '../../src/mock/diag';
import { ToastHost } from '../../src/shell/toast';
import { NOW, WIRE_TURNS } from '../../src/mock/fixtures';
import { C1_TURNS } from '../../src/mock/fixtures/chatDemo';
import { flowOf, pathOf } from '../../src/pages/diag/flow';
import { bucketsOf } from '../../src/pages/diag/HourBars';
import { DiagPage } from '../../src/pages/diag/Page';
import type { WireTraceEvent } from '../../src/pages/diag/wire';

function mount(hash: string) {
  window.location.hash = `#/diag?${hash}`;
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1&${hash}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const node = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label^="${label} │ "]`);
const row = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
  vi.useRealTimers();
});

describe('diag page', () => {
  it('总览 lists the link rows as a tree, then the pipeline and proactive speech rows, then the error records', async () => {
    mount('');
    await waitFor(() => expect(row('flow')).not.toBeNull());
    const heads = [...document.querySelectorAll('[data-stub="SecHead"] h3')].map((h) => h.textContent);
    expect(heads).toEqual(['链路', '运行', '错误']);
    expect([...document.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))).toEqual(['agentd', 'runtime', 'avatar', 'voice', 'flow', 'gate']);
    expect(within(row('voice')!).getByText('无法连接')).toBeTruthy();
    expect(within(row('voice')!).getByRole('button', { name: '重新连接' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['总览', '进程', '帧与负载', '链路', '内部状态', '对话轮次', '事件线', '行为决策', '日志']);
  });

  it('a row\'s › opens its tab', async () => {
    mount('');
    await waitFor(() => expect(row('flow')).not.toBeNull());
    fireEvent.click(within(row('flow')!).getByRole('button', { name: '查看链路' }));
    expect(window.location.hash).toContain('/diag?tab=flow');
  });

  it('item=avatar highlights that row on 总览; item=usage opens 管道 at 模型调用; item=state opens 状态', async () => {
    mount('item=avatar');
    await waitFor(() => expect(row('avatar')?.querySelector('[data-hl]')).not.toBeNull());
    cleanup();
    mount('item=usage');
    expect(await screen.findByRole('region', { name: '模型调用' })).toBeTruthy();
    expect(document.querySelector('[data-nav-target="diag-usage"]')).not.toBeNull();
    cleanup();
    mount('item=state');
    await waitFor(() => expect(document.querySelector('[data-nav-target="diag-state"]')).not.toBeNull());
  });

  it('状态 shows how many completed lines were in another language than the reply language', async () => {
    mount('tab=state');
    await waitFor(() => expect(screen.getByText(/回答语言错配/).textContent).toBe('回答语言错配 1/23'));
    expect(screen.getByRole('region', { name: '主动发言闸门' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '现在' })).toBeTruthy();
  });

  it('管道: a node opens its detail; 取消选中 and Esc close it', async () => {
    mount('tab=flow');
    await waitFor(() => expect(node('语音')).not.toBeNull());
    fireEvent.click(node('语音')!);
    expect(node('语音')!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '取消选中' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消选中' }));
    expect(node('语音')!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(node('语音')!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(node('语音')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('管道: 观察, 解读 and 记忆提取 keep no count and open their 记忆管线 station', async () => {
    mount('tab=flow');
    await waitFor(() => expect(node('观察')).not.toBeNull());
    expect(node('观察')!.textContent).toContain('记忆管线');
    fireEvent.click(node('记忆提取')!);
    expect(window.location.hash).toContain('/memory?view=pipeline&station=mem');
  });

  it('the 7 天 range re-reads /trace/turns a week back', async () => {
    const calls: string[] = [];
    const fake = window.agenticComplex!;
    window.agenticComplex = { ...fake, agentd: { ...fake.agentd, request: (m, p, b) => (calls.push(p), fake.agentd.request(m, p, b)) } };
    mount('tab=flow');
    await waitFor(() => expect(node('模型')).not.toBeNull());
    fireEvent.click(screen.getByRole('radio', { name: '7 天' }));
    const week = encodeURIComponent(isoWithOffset(NOW - 7 * 86_400_000));
    await waitFor(() => expect(calls).toContain(`/trace/turns?since=${week}&limit=200`));
  });

  it('an hour bar opens 对话轮次 at that hour', async () => {
    mount('tab=flow');
    await waitFor(() => expect(node('模型')).not.toBeNull());
    const bars = screen.getAllByRole('button', { name: /轮，失败 \d+，在对话轮次里打开$/ });
    expect(bars).toHaveLength(24);
    fireEvent.click(bars[23]!);
    expect(window.location.hash).toMatch(/\/diag\?tab=turns&at=\d+/);
  });

  it('管道: a main-line node reads its p50 from /diag/state stages', async () => {
    mount('tab=flow');
    await waitFor(() => expect(node('模型')!.getAttribute('aria-label')).toContain('p50 3.1 s'));
  });

  it('sparse: the coding-tool lane is idle', async () => {
    mount('tab=flow&demo=sparse');
    await waitFor(() => expect(node('会话')).not.toBeNull());
    expect(node('会话')!.getAttribute('data-st')).toBe('idle');
  });

  it('error: agentd gone shows the alert with 重启后台服务 and disables 暂停', async () => {
    mount('state=error');
    const alert = (await screen.findByText('后台服务无响应')).closest('[role="alert"]') as HTMLElement;
    expect(within(alert).getByRole('button', { name: /重启后台服务/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('full: shows the stage p50s and the process history the backend does not send yet', async () => {
    mount('tab=flow&demo=full');
    await waitFor(() => expect(node('模型')!.getAttribute('aria-label')).toContain('近 1 小时 18 次 │ p50 3.1 s'));
    cleanup();
    mount('tab=proc&demo=full');
    await waitFor(() => expect(document.body.textContent).toMatch(/近 \d+ 分钟/));
    expect(screen.getByRole('img', { name: /后台服务 CPU/ })).toBeTruthy();
  });
});

describe('diag restart', () => {
  let sup: Record<'agentd' | 'avatar', ProcessState>;
  let restarts: string[];
  let reads: number;
  let push: (e: StreamEvent) => void;
  beforeEach(() => {
    sup = { agentd: { state: 'running', pid: 100 }, avatar: { state: 'running', pid: 200 } };
    restarts = [];
    reads = 0;
    push = () => {};
    const fake = window.agenticComplex!;
    window.agenticComplex = {
      ...fake,
      supervisor: { state: async () => ((reads += 1), sup), restart: async (t) => void restarts.push(t) },
      diag: { subscribe: (on) => ((push = on), () => {}) },
    };
  });
  const menu = async (item: string, confirm: string) => {
    fireEvent.click(screen.getAllByRole('button', { name: '重启' }).find((b) => b.getAttribute('aria-haspopup') === 'menu')!);
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
    const dialog = screen.getByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: confirm })));
  };

  it('a dispatched restart stays 正在重启 until supervisor.state shows new pids; 全部重启 names no Companion; a second restart meanwhile is not sent', async () => {
    mount('tab=proc');
    render(<ToastHost />);
    await waitFor(() => expect(document.querySelector('[data-nav-target="proc-agentd"]')?.textContent).toContain('pid 100'));
    fireEvent.click(screen.getAllByRole('button', { name: '重启' }).find((b) => b.getAttribute('aria-haspopup') === 'menu')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '全部重启…' }));
    expect(screen.getByRole('dialog').textContent).not.toContain('Companion');
    const before = reads;
    await act(async () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '全部重启' })));
    expect(restarts).toEqual(['all']);
    // The shell answered and supervisor.state was read again, still with the old pids.
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await act(async () => {});
    expect(document.body.textContent).not.toContain('已重启');
    expect(document.body.textContent).not.toContain('Companion');
    expect(screen.getAllByText('◌ 正在重启…')).toHaveLength(2);
    await menu('重启后台服务', '重启后台服务');
    expect(restarts).toEqual(['all']);
    sup = { agentd: { state: 'running', pid: 101 }, avatar: { state: 'running', pid: 201 } };
    act(() => push({ event: 'state', id: 'b-1', data: JSON.stringify(DIAG_STATE) } as StreamEvent));
    await waitFor(() => expect(screen.getAllByText(/^✓ 已重启 │ /)).toHaveLength(2));
    expect(screen.getByText('已全部重启：后台服务、角色')).toBeTruthy();
  });

  it('an agentd that comes back failed is 重启失败, not 已重启', async () => {
    mount('tab=proc');
    render(<ToastHost />);
    await waitFor(() => expect(document.querySelector('[data-nav-target="proc-agentd"]')?.textContent).toContain('pid 100'));
    await menu('重启后台服务', '重启后台服务');
    expect(restarts).toEqual(['agentd']);
    sup = { ...sup, agentd: { state: 'failed(exit 3)', pid: null } };
    act(() => push({ event: 'state', id: 'b-1', data: JSON.stringify(DIAG_STATE) } as StreamEvent));
    await waitFor(() => expect(screen.getByText('■ 重启失败')).toBeTruthy());
    expect(document.body.textContent).not.toContain('已重启');
    expect(screen.getByText('后台服务未能重新启动')).toBeTruthy();
  });
});

describe('diag mock', () => {
  it('a /trace/turns row carries the same turn_id as the conversation turn', () => {
    const ids = new Set(TRACE_TURNS.map((r) => r.turn_id));
    for (const t of WIRE_TURNS) expect(ids).toContain(t.turn_id);
    for (const t of C1_TURNS.filter((x) => x.source === 'text')) expect(ids).toContain(t.turn_id);
  });
});

describe('diag flow model', () => {
  const turn = (id: string, source: string, result: Turn['result'], at = NOW - 60_000): Turn => ({ id, turn_id: id, source, result, started_at: at, duration_ms: 1000, stages: [], marks: [] });
  const ev = (kind: string, attrs: Record<string, unknown> = {}): WireTraceEvent => ({ event_id: kind, trace_id: 't', turn_id: null, kind, status: 'ok', t_wall: isoWithOffset(NOW - 60_000), attrs });

  it('paths: proactive turns enter from the observation lane; skips stop at the judge', () => {
    expect(pathOf('proactive', 'ok').slice(0, 3)).toEqual(['obs', 'interp', 'ctx']);
    expect(pathOf('text', 'skipped')).toEqual(['input', 'ctx', 'judge']);
    expect(pathOf('text', 'failed', 'tts').at(-1)).toBe('tts');
  });

  it('counts the last hour only, puts a failure on its node, and marks an open approval', () => {
    const { nodes, edges } = flowOf({
      turns: [turn('a', 'text', 'ok'), turn('b', 'text', 'failed'), turn('old', 'text', 'ok', NOW - 7_200_000), turn('p', 'proactive', 'ok')],
      decisions: [ev('approval.opened', { request_id: 'x' })],
      since: NOW - 3_600_000,
      failAt: { b: 'tts' },
      voiceDown: false,
      hookSub: '已安装',
    });
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(by.input?.stat?.count).toBe(2);
    expect(by.tts?.state).toBe('fail');
    expect(by.tts?.stat?.fail).toBe(1);
    expect(by.appr?.state).toBe('att');
    expect(by.hook?.sub).toBe('已安装');
    expect(edges.find((e) => e.from === 'input' && e.to === 'ctx')?.n).toBe(2);
    // The memory pipeline's stations keep no count of their own here.
    expect([by.obs?.stat, by.interp?.stat, by.memx?.stat]).toEqual([null, null, null]);
    expect([by.obs?.station, by.interp?.station, by.memx?.station]).toEqual(['obs', 'interp', 'mem']);
    expect(edges.find((e) => e.from === 'obs' && e.to === 'interp')?.n).toBeUndefined();
  });

  it('a node with a /diag/state stages median shows it; one without keeps null', () => {
    const { nodes } = flowOf({ turns: [turn('a', 'text', 'ok')], decisions: [], since: NOW - 3_600_000, failAt: {}, voiceDown: false, hookSub: '', p50: { model: 3120 } });
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(by.model?.stat?.p50).toBe(3120);
    expect(by.input?.stat?.p50).toBeNull();
  });

  it('buckets 24 hours of turns with failures and the p50', () => {
    const b = bucketsOf([turn('a', 'text', 'ok', NOW - 60_000), turn('b', 'text', 'failed', NOW - 120_000)], '24h', NOW);
    expect(b).toHaveLength(24);
    expect(b.at(-1)).toMatchObject({ n: 2, fail: 1, p50: 1000 });
    expect(bucketsOf([], '7d', NOW)).toHaveLength(7);
  });
});
