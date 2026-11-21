// Diag: one page — health, pipeline flow, turn timeline with the turn's details, resources, processes, internal state.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { Turn } from '../../src/domain';
import { isoWithOffset } from '../../src/domain/units';
import { TRACE_TURNS, turnEvents } from '../../src/mock/diag';
import { NOW, WIRE_TURNS } from '../../src/mock/fixtures';
import { C1_TURNS } from '../../src/mock/fixtures/chatDemo';
import { flowOf, pathOf } from '../../src/pages/diag/flow';
import { inspectorOf } from '../../src/pages/diag/inspector';
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
  it('renders the processes in the health strip, then the numbered sections in order', async () => {
    mount('');
    await waitFor(() => expect(node('模型')).not.toBeNull());
    const heads = [...document.querySelectorAll('[data-stub="SecHead"] h3')].map((h) => h.textContent);
    expect(heads).toEqual(['流程图', '轮次时间轴', '资源']);
    const procs = screen.getByRole('region', { name: '进程' });
    expect(procs.compareDocumentPosition(screen.getByRole('region', { name: '流程图' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('内部状态')).toBeTruthy();
    expect(screen.getByRole('img', { name: /轮次时间轴：\d+ 轮/ })).toBeTruthy();
  });

  it('内部状态 shows how many completed lines were in another language than the reply language', async () => {
    mount('');
    await waitFor(() => expect(node('模型')).not.toBeNull());
    expect(screen.getByText('回答语言错配 1/23')).toBeTruthy();
  });

  it('clicking a node filters the turns by it and shows the chip; ✕ clears it', async () => {
    mount('');
    await waitFor(() => expect(node('解读')).not.toBeNull());
    const all = screen.getByRole('img', { name: /轮次时间轴/ }).getAttribute('aria-label');
    fireEvent.click(node('解读')!);
    expect(node('解读')!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/下方时间轴已按此节点筛选/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /轮次时间轴/ }).getAttribute('aria-label')).not.toBe(all);
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('img', { name: /轮次时间轴/ }).getAttribute('aria-label')).toBe(all);
  });

  it('a selected turn lights its path, shows 轮次详情 and leaves with 退出回放', async () => {
    mount('sel=tr3');
    expect(await screen.findByText('轮次详情')).toBeTruthy();
    await waitFor(() => expect(node('模型')!.hasAttribute('data-lit')).toBe(true));
    expect(node('观察')!.hasAttribute('data-dim')).toBe(true);
    expect(screen.getByRole('button', { name: '完整运行记录 ↗' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退出回放' }));
    expect(screen.queryByText('轮次详情')).toBeNull();
    expect(node('观察')!.hasAttribute('data-dim')).toBe(false);
  });

  it('the selected turn opens the chat page turn inspector', async () => {
    mount('sel=tr3');
    expect(await screen.findByText('轮次详情')).toBeTruthy();
    expect(await screen.findByText('引用记忆')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '判断', level: 4 })).toBeTruthy();
  });

  it('the 7 天 range re-reads /trace/turns a week back', async () => {
    const calls: string[] = [];
    const fake = window.agenticComplex!;
    window.agenticComplex = { ...fake, agentd: { ...fake.agentd, request: (m, p, b) => (calls.push(p), fake.agentd.request(m, p, b)) } };
    mount('');
    await waitFor(() => expect(node('模型')).not.toBeNull());
    fireEvent.click(screen.getByRole('radio', { name: '7 天' }));
    const week = encodeURIComponent(isoWithOffset(NOW - 7 * 86_400_000));
    await waitFor(() => expect(calls).toContain(`/trace/turns?since=${week}&limit=200`));
  });

  it('sparse: nine turns today, the hook lane idle', async () => {
    mount('demo=sparse');
    await waitFor(() => expect(screen.getByRole('img', { name: /轮次时间轴/ }).getAttribute('aria-label')).toMatch(/^轮次时间轴：9 轮，失败 1 轮/));
    expect(node('会话')!.getAttribute('data-st')).toBe('idle');
  });

  it('error: agentd gone shows the alert, greys the flow and offers 重启后台服务', async () => {
    mount('state=error');
    const alert = (await screen.findByText(/后台服务无响应/)).closest('[role="alert"]') as HTMLElement;
    expect(within(alert).getByRole('button', { name: /重启后台服务/ })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-dead]')).not.toBeNull());
    expect(screen.getByRole('button', { name: '暂停' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('full: shows the stage p50s and the process history the backend does not send yet', async () => {
    mount('demo=full');
    await waitFor(() => expect(node('模型')!.getAttribute('aria-label')).toContain('近 1 小时 18 次 │ p50 3.1 s'));
    expect(screen.getByText('30 分钟 │ 按进程')).toBeTruthy();
  });
});

describe('diag mock and inspector', () => {
  it('a /trace/turns row carries the same turn_id as the conversation turn', () => {
    const ids = new Set(TRACE_TURNS.map((r) => r.turn_id));
    for (const t of WIRE_TURNS) expect(ids).toContain(t.turn_id);
    for (const t of C1_TURNS.filter((x) => x.source === 'text')) expect(ids).toContain(t.turn_id);
  });

  it('builds the chat TurnTrace: turn_id, chat span families and event details', () => {
    const r = TRACE_TURNS.find((x) => x.trace_id === 'tr8')!;
    const t: Turn = { id: r.trace_id, turn_id: r.turn_id, source: r.source, result: 'ok', started_at: Date.parse(r.started_at), duration_ms: r.duration_ms, stages: [], marks: [] };
    const tr = inspectorOf(t, turnEvents('tr8')!.events, 4);
    expect(tr).toMatchObject({ no: 4, id: 'tr8', turn_id: 'tr8', res: '成功', mems: [], learned: [] });
    expect(tr.spans.map((s) => s.id)).toEqual(['input', 'ctx', 'model', 'line', 'tts', 'play']);
    expect(tr.events[0]?.d).toBe('用户发起');
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
      turns: [turn('a', 'text', 'ok'), turn('b', 'text', 'failed'), turn('old', 'text', 'ok', NOW - 7_200_000)],
      runs: [],
      decisions: [ev('approval.opened', { approval_id: 'x' })],
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
  });
});
