import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { PLUGINS } from '../../src/bridge/plugins.generated';
import type { WireTraceTurn } from '../../src/domain/wire';
import { isoWithOffset } from '../../src/domain';
import type { MockRoute } from '../../src/mock';
import { NOW, WIRE_RUNS } from '../../src/mock/fixtures';
import { at } from '../../src/mock/fixtures/clock';
import { C1, T1 } from '../../src/mock/fixtures/ids';
import { WIRE_CONVERSATIONS } from '../../src/mock/fixtures/wire/chat';
import { WIRE_TASK_ROWS } from '../../src/mock/fixtures/wire/work';
import { ChatPage } from '../../src/pages/chat/Page';
import { TurnInspector } from '../../src/pages/chat/TurnInspector';
import { useBottomPin } from '../../src/pages/chat/useBottomPin';
import { buildTurnTrace, type TraceEvent } from '../../src/pages/chat/turnTrace';
import { stubMatchMedia } from './mediaStub';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window.agenticComplex;
});

async function mount(search = '') {
  const root = createRootRoute({ component: ChatPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: '消息' });
}

const t0 = at(14, 26, 2);
const ev = (kind: string, ms: number, attrs: Record<string, unknown> = {}, status = 'ok', duration_ms?: number): TraceEvent => ({
  kind,
  status,
  t_wall: isoWithOffset(t0 + ms),
  attrs,
  ...(duration_ms != null ? { duration_ms } : {}),
});
const row: WireTraceTurn = { trace_id: 'tr-x', turn_id: 'turn-x', source: 'proactive', head: null, len: null, producers: ['agentd'], started_at: isoWithOffset(t0), result: 'interrupted', duration_ms: 3000 };
/** Events as agentd emits them (trace_format.py KINDS); no cache tokens, cost or motion length yet. */
const EVENTS: TraceEvent[] = [
  ev('judge.decided', 0, { backend: 'haiku', answers: [{ id: 'want_comment', value: 'yes', prob: 0.8 }] }),
  ev('input.received', 10, { source: 'proactive', text: null }),
  ev('context.assembled', 300, { items: [] }),
  ev('model.started', 320, { model: 'claude-sonnet-4-5', call: 'mouth' }),
  ev('model.first_token', 900),
  ev('model.finished', 1500, { model: 'claude-sonnet-4-5', input_tokens: 4200, output_tokens: 180, stop_reason: 'end_turn' }, 'ok', 1180),
  ev('line.parsed', 1520, { line_id: 'turn-x', intents: [], target: null, first_sentence_only: false }),
  ev('speech.requested', 1550, { speech_id: 's' }),
  ev('speech.first_audio', 1900, { speech_id: 's' }),
  ev('playback.started', 1950, { speech_id: 's' }),
  ev('playback.interrupted', 3000, { speech_id: 's', reason: 'barge_in', planned_ms: 1800 }, 'cancelled', 1050),
  ev('motion.started', 2000, { behavior_id: null, clip: '点头附和' }),
];

describe('chat: turn trace from /trace/turns/{id}', () => {
  const tr = buildTurnTrace({ no: 12, row, events: EVENTS, mems: [{ id: 'f2', text: '在 Endfield 仓库工作' }] });

  it('builds spans with parents, the first token and the result', () => {
    expect(tr.spans.map((s) => [s.id, s.parent])).toEqual([
      ['input', null],
      ['ctx', null],
      ['judge', null],
      ['model', null],
      ['line', 'model'],
      ['tts', null],
      ['play', 'tts'],
      ['motion', null],
    ]);
    expect(tr.ttft).toBe(900);
    expect(tr.spans.find((s) => s.id === 'model')).toMatchObject({ t0: 320, dur: 1180 });
    expect(tr.spans.find((s) => s.id === 'line')?.t0).toBe(900);
    expect(tr.spans.find((s) => s.id === 'play')?.st).toBe('cut');
    expect(tr.res).toBe('打断');
    expect(tr.src).toBe('proactive');
  });

  it('keeps fields agentd does not send as null: cache, cost, motion length', () => {
    expect(tr.model).toEqual({ name: 'claude-sonnet-4-5', in: 4200, cache: null, out: 180, cost: null });
    expect(tr.motion).toEqual({ name: '点头附和', ms: null });
    expect(tr.judge).toEqual([{ k: 'want_comment', l: '倾向发言', p: 0.8 }]);
    expect(tr.pick).toBe('want_comment');
  });

  it('aligns producer clocks and separates terminal state from incomplete receipts', () => {
    const events = [
      ev('input.received', 0, { source: 'background' }),
      ev('tool.started', 20, { tool: 'workspace_read' }),
      ev('tool.settled', 45, { tool: 'workspace_read', outcome: 'completed' }),
      { ...ev('playback.started', 30), producer: 'avatar', producer_epoch: 42 },
      ev('behavior.dispatched', 65, { behavior_id: 'one', behavior_type: 'point' }),
      ev('behavior.receipt', 80, { behavior_id: 'one', behavior_type: 'point', phase: 'rejected', reason: 'actor_hidden' }),
      ev('turn.settled', 100, { state: 'completed', outcome: 'needs_review' }),
    ];
    const aligned = buildTurnTrace({ no: 1, row: { ...row, result: 'unknown' }, events, skew: { 'avatar/42': 30 } });
    expect(aligned.src).toBe('background');
    expect(aligned.turnState).toBe('completed');
    expect(aligned.turnOutcome).toBe('needs_review');
    expect(aligned.behavior).toEqual({ name: 'point', phase: 'rejected', reason: 'actor_hidden' });
    expect(aligned.res).toBe('状态未知');
    expect(aligned.events.find((e) => e.name === 'playback.started')?.t).toBe(60);
    expect(aligned.spans.find((s) => s.id === 'tool')).toMatchObject({ t0: 20, dur: 25 });
  });

  it('the narrow inspector shows 瀑布, 引用记忆, 判断, 模型 and folds the rest into 更多', () => {
    render(<TurnInspector tr={tr} />);
    expect(screen.getByText('第 12 轮')).toBeTruthy();
    for (const h of ['瀑布', '引用记忆', '判断', '模型']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    expect(screen.getByText('未计价')).toBeTruthy();
    expect(screen.queryByText('缓存')).toBeNull();
    expect(screen.getByRole('list', { name: /^判断：倾向发言 0.80，选中倾向发言/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '观察' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    for (const h of ['观察', '动作', '事件']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    const observe = screen.getByRole('heading', { name: '观察' }).closest('section')!;
    expect(within(observe).getByText('—')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(EVENTS.length + 1);
  });

  it('角色 ↗ on 动作 opens the motion table on the clip the turn played', () => {
    window.location.hash = '';
    render(<TurnInspector tr={tr} wide />);
    fireEvent.click(screen.getByText('角色 ↗').closest('button')!);
    const q = new URLSearchParams(window.location.hash.split('?')[1]);
    expect([window.location.hash.split('?')[0], q.get('pane'), q.get('row')]).toEqual(['#/character', 'motion', '点头附和']);
    window.location.hash = '';
  });

  it('the wide inspector (diag) opens every section and folds only the events', () => {
    render(<TurnInspector tr={tr} wide />);
    for (const h of ['瀑布', '引用记忆', '判断', '模型', '观察', '动作']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^事件/ }));
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('lands the motion on the character page\'s 动作表, a pane the page opens', () => {
    window.location.hash = '';
    render(<TurnInspector tr={tr} wide />);
    fireEvent.click(screen.getByRole('button', { name: /点头附和/ }));
    const q = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(window.location.hash).toMatch(/^#\/character\?/);
    expect(q.get('pane')).toBe('motion');
    expect(q.get('tab')).toBeNull();
  });

  it('says why when there is no turn', () => {
    render(<TurnInspector tr={null} />);
    expect(screen.getByText(/选择一轮以查看详情/)).toBeTruthy();
  });
});

describe('chat page', () => {
  it('keeps one transcript, the topic rows with their last line, and the memory tags (full demo)', async () => {
    const thread = await mount('&demo=full');
    const nav = screen.getByRole('navigation', { name: '话题' });
    const metal = (await within(nav).findByText('Metal 帧率调优')).closest('button')!;
    expect(metal.textContent).toMatch(/^Metal 帧率调优主要耗时在阴影 pass，降一级阴影分辨率后 p95 回到 7\.9 ms。10月27日$/);
    expect(within(metal).queryByRole('img')).toBeNull();
    expect(within(nav).queryByRole('region', { name: '全部台词' })).toBeNull();
    expect(screen.queryByRole('region', { name: '历史记录' })).toBeNull();
    const tag = await within(thread).findByRole('button', { name: /\+ 新增记忆 1 条/ });
    const reply = tag.closest<HTMLElement>('[data-kind="ai"]')!;
    expect(within(reply).getByRole('button', { name: /引用记忆 2 条/ })).toBeTruthy();
  });

  it('a reply’s right-click menu opens its turn in 诊断 › 对话轮次', async () => {
    const thread = await mount('&demo=full');
    const tag = await within(thread).findByRole('button', { name: /\+ 新增记忆 1 条/ });
    fireEvent.contextMenu(tag.closest<HTMLElement>('[data-kind="ai"]')!.querySelector('[data-first]')!.closest('div')!.querySelector('p, div')!, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: '在诊断中查看此轮' }));
    expect(window.location.hash).toMatch(/\/diag\?tab=turns&turn=tr7/);
  });

  it('at 900px the task opens as an overlay that Esc closes', async () => {
    stubMatchMedia(new Set(['(max-width: 1099px)', '(max-width: 1000px)']));
    const thread = await mount('&demo=full');
    fireEvent.click(await within(thread).findByRole('button', { name: /^任务 整理本周提交周报/ }));
    expect(await screen.findByRole('dialog', { name: '任务' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '任务' })).toBeNull();
  });

  it('sparse: one conversation, four replies, idle', async () => {
    const thread = await mount('&demo=sparse');
    const nav = screen.getByRole('navigation', { name: '话题' });
    expect(await within(nav).findByText('HostLink 早上')).toBeTruthy();
    await waitFor(() => expect(thread.querySelectorAll('[data-kind="ai"]')).toHaveLength(4));
    expect(screen.getByText('空闲')).toBeTruthy();
  });

  it('error: the failure shows once, in the message area, and the input box stays', async () => {
    const thread = await mount('&state=error');
    expect(await within(thread).findByText(/读取对话失败/)).toBeTruthy();
    expect(within(thread).getByRole('button', { name: /重试/ })).toBeTruthy();
    expect(document.querySelectorAll('[data-stub="ErrBar"]')).toHaveLength(1);
    expect(screen.queryByText(/没读到对话列表/)).toBeNull();
    expect(within(thread).getByRole('textbox')).toBeTruthy();
  });

  it('an open question opens the stream at its card, not at the bottom', async () => {
    const thread = await mount();
    await waitFor(() => expect(thread.querySelectorAll('[data-pending]').length).toBeGreaterThan(0));
    const el = document.createElement('div');
    const card = document.createElement('div');
    card.setAttribute('data-pending', 'true');
    el.append(document.createElement('p'), card);
    let top = 0;
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => (top = v) });
    Object.defineProperty(el, 'scrollHeight', { value: 2000 });
    el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    card.getBoundingClientRect = () => ({ top: 700 }) as DOMRect;
    renderHook(() => useBottomPin({ current: el }, true, []));
    expect(top).toBe(592);
    card.removeAttribute('data-pending');
    renderHook(() => useBottomPin({ current: el }, true, []));
    expect(top).toBe(2000);
  });
});

describe('chat: 停止', () => {
  /** A bridge over the mock routes plus `routes` that records each agentd POST. */
  function recording(routes: MockRoute[] = []) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const base = createFakeBridge({ surface: 'main', still: true, routes });
    const posts: Array<{ path: string; body: unknown }> = [];
    window.agenticComplex = {
      ...base,
      agentd: { ...base.agentd, request: (method, path, body) => (method === 'POST' && posts.push({ path, body }), base.agentd.request(method, path, body)) },
      feed: { subscribe: () => () => {} },
    };
    return posts;
  }
  const idleList: MockRoute = { method: 'GET', path: '/conversations', handler: () => ({ status: 200, body: { conversations: WIRE_CONVERSATIONS, busy: false } }) };
  const stop = async () => {
    await screen.findByText(/^执行中/);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
  };
  const confirm = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '停止任务' }));

  it('stops a topic whose only run is a background job through the job’s own cancel', async () => {
    const bg = (r: { run_id: string | null }) => (r.run_id === 'run-8d03' ? { ...r, run_id: 'bg-8d03' } : r);
    const job = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T1)!.job_id!;
    const posts = recording([
      { method: 'GET', path: '/agent/runs', handler: () => ({ status: 200, body: { runs: WIRE_RUNS.map(bg) } }) },
      { method: 'GET', path: '/agent/tasks', handler: () => ({ status: 200, body: { tasks: WIRE_TASK_ROWS.map(bg), next_cursor: null } }) },
    ]);
    await mount();
    await stop();
    confirm();
    await waitFor(() => expect(posts.map((p) => p.path)).toContain(`/agent/jobs/${job}/cancel`));
    expect(posts.some((p) => p.path.endsWith('/cancel') && p.path.startsWith('/conversations/'))).toBe(false);
  });

  it('with 个人代理 off, stops the line that is being answered by its run', async () => {
    pluginsOn(...PLUGINS.map((p) => p.id).filter((id) => id !== 'personal_agent'));
    const posts = recording([{ method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 202, body: { line_id: 'line-x', generation: 2, run_id: 'line-x' } }) }]);
    const thread = await mount();
    fireEvent.change(await within(thread).findByRole('textbox', { name: '消息' }), { target: { value: '在吗' } });
    fireEvent.click(within(thread).getByRole('button', { name: '发送' }));
    await stop();
    confirm();
    await waitFor(() => expect(posts.filter((p) => p.path === `/conversations/${C1}/cancel`).map((p) => p.body)).toEqual([{ run_id: 'line-x', generation: 2 }]));
  });

  it('stops the topic the dialog was opened in, though another one is shown by the time it is confirmed', async () => {
    const posts = recording([idleList]);
    await mount();
    await stop();
    fireEvent.click(within(screen.getByRole('navigation', { name: '话题' })).getByText('HostLink 断线排查'));
    await screen.findByRole('button', { name: '继续此对话' });
    confirm();
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/cancel')).map((p) => p.path)).toEqual([`/conversations/${C1}/cancel`]));
  });
});
