import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgenticComplexBridge, StreamEvent } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { WireRunItem, WireTurn } from '../../src/domain';
import type { MockRoute } from '../../src/mock';
import { NOW, WIRE_CONVERSATIONS, WIRE_INTERACTION_APPROVAL, WIRE_INTERACTIONS, WIRE_TASK_ROWS, WIRE_TURNS } from '../../src/mock/fixtures';
import { C1, C2, Q1, Q_APPROVAL, T1 } from '../../src/mock/fixtures/ids';
import { createChatActions, type ChatDeps } from '../../src/pages/chat/actions';
import { reasonOf } from '../../src/pages/chat/reasons';
import { ChatPage } from '../../src/pages/chat/Page';
import { chatStream } from '../../src/pages/chat/stream';
import { ToastHost } from '../../src/shell/toast';
import { AgentdCallError, get } from '../../src/bridge/agentd';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so the page reads and shows what its plug-ins add.
beforeEach(() => pluginsOn());
afterEach(() => pluginsReset());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.agenticComplex;
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A native-like bridge over the mock routes plus `routes`, recording every agentd request; `emit` plays a feed event. */
function bridge(routes: MockRoute[] = [], capabilities: Partial<AgenticComplexBridge['capabilities']> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const base = createFakeBridge({ surface: 'main', still: true, routes, capabilities });
  const calls: Call[] = [];
  let onEvent: ((e: StreamEvent) => void) | null = null;
  let onReload: (() => void) | null = null;
  window.agenticComplex = {
    ...base,
    agentd: {
      ...base.agentd,
      request: (method, path, body) => {
        calls.push({ method, path, body });
        return base.agentd.request(method, path, body);
      },
    },
    feed: {
      subscribe: (e, r) => {
        onEvent = e;
        onReload = r;
        return () => {};
      },
    },
  };
  const emit = (event: string, data: unknown) => act(() => onEvent?.({ event, id: null, data: JSON.stringify(data) }));
  const of = (method: string, prefix: string) => calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  return { calls, emit, of, reload: () => act(() => onReload?.()) };
}

const idleList: MockRoute = { method: 'GET', path: '/conversations', handler: () => ({ status: 200, body: { conversations: WIRE_CONVERSATIONS, busy: false } }) };

async function mount(search = '') {
  const root = createRootRoute({ component: ChatPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastHost />
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: '消息' });
}

const topics = () => screen.getByRole('navigation', { name: '话题' });
const rowOf = (title: string) => within(topics()).getByText(title).closest('button')!;
/** Right-clicks the topic row and takes `name` from its menu. */
const menu = (title: string, name: RegExp | string) => {
  fireEvent.contextMenu(rowOf(title), { clientX: 40, clientY: 60 });
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name }));
};

describe('chat reads', () => {
  it('reads conversations, turns and the three task reads; never lanes or messages', async () => {
    const b = bridge();
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    await waitFor(() => expect(b.of('GET', '/agent/runs').length).toBeGreaterThan(0));
    const gets = b.calls.filter((c) => c.method === 'GET').map((c) => c.path);
    expect(gets).toContain('/conversations?character=si');
    expect(gets).toContain(`/conversations/${C1}/turns`);
    expect(gets).toContain(`/agent/tasks?conversation_id=${C1}&limit=100`);
    expect(gets).toContain('/agent/interactions');
    expect(gets).toContain('/agent/runs');
    expect(gets).toContain('/character/runtime');
    expect(gets.some((p) => /lanes|messages|runs\/live/.test(p))).toBe(false);
    for (const c of b.calls.filter((x) => x.method === 'GET')) expect(c.body).toBeUndefined();
  });

  it('shows her topics, pinned first, each row with its last line and time, and archived rows', async () => {
    bridge();
    await mount();
    const nav = topics();
    expect(await within(nav).findByText('周报整理')).toBeTruthy();
    // A pinned row says 置顶 where the others have their last time.
    expect(rowOf('周报整理').textContent).toMatch(/^周报整理初步看是 10-27 那组.*置顶$/);
    expect(rowOf('HostLink 断线排查').textContent).toMatch(/^HostLink 断线排查日志里 11:38 心跳连续 3 次超时，之后重连成功。.*11:40$/);
    expect(within(nav).getByRole('button', { name: '已归档 3' })).toBeTruthy();
    const thread = screen.getByRole('region', { name: '消息' });
    expect(await within(thread).findByText(/改好了：Companion 58 条/)).toBeTruthy();
    // The pending question (14:27) sits in the stream at its creation time, before the 14:29 turn.
    const kinds = [...thread.querySelectorAll<HTMLElement>('[data-kind]')].map((n) => n.dataset.kind).filter((k) => k !== 'undefined');
    expect(kinds.slice(-3)).toEqual(['question', 'me', 'ai']);
  });

  it('shows a turn end state, a spoken source and another character by name', async () => {
    const turns: WireTurn[] = [
      { ...WIRE_TURNS[0]!, state: 'cancelled', source: 'voice' },
      { ...WIRE_TURNS[1]!, character_id: 'voice_a' },
    ];
    bridge([{ method: 'GET', path: '/conversations/:id/turns', handler: () => ({ status: 200, body: { turns, before: null } }) }]);
    const thread = await mount();
    expect(await within(thread).findByText('■ 已取消')).toBeTruthy();
    expect(within(thread).getAllByText(/│ 语音/).length).toBe(1);
    const reply = within(thread).getByText(/改好了：Companion/).closest<HTMLElement>('[data-kind="ai"]')!;
    expect(within(reply).getByText('示例甲')).toBeTruthy();
  });

  it('loads older turns with ?before= and hides the button when agentd says there are none', async () => {
    const older: WireTurn = { ...WIRE_TURNS[0]!, id: 120, turn_id: 'tr1', user_text: '上周的周报也在吗？', reply: '在，放在 2026-W43。' };
    const b = bridge([
      {
        method: 'GET',
        path: '/conversations/:id/turns',
        handler: ({ query }) => ({ status: 200, body: query.get('before') === '301' ? { turns: [older], before: null } : { turns: WIRE_TURNS, before: 301 } }),
      },
    ]);
    const thread = await mount();
    fireEvent.click(await within(thread).findByRole('button', { name: '加载更早的消息' }));
    expect(await within(thread).findByText('上周的周报也在吗？')).toBeTruthy();
    expect(b.of('GET', `/conversations/${C1}/turns?before=301`)).toHaveLength(1);
    await waitFor(() => expect(within(thread).queryByRole('button', { name: '加载更早的消息' })).toBeNull());
  });

  it('shows the plan from the run plan item, then from plan events', async () => {
    const steps = [
      { text: '读取提交记录', status: 'completed' },
      { text: '按项目重写为 v2', status: 'completed' },
      { text: '生成提交统计表', status: 'in_progress' },
    ];
    const item: WireRunItem = { run_id: 'run-8d03', item_id: 'run-8d03:plan', seq: 3, kind: 'plan', phase: null, status: 'in_progress', name: null, summary: null, text: '', parent_item_id: null, created_at: 0, updated_at: 0, steps };
    const b = bridge([{ method: 'GET', path: '/agent/runs/:id/items', handler: () => ({ status: 200, body: { items: [item] } }) }]);
    const thread = await mount();
    // The header status (in place without the shell): 2 of 3 done, so step 3 runs.
    const status = () => screen.getByText(/^执行中/).textContent;
    await waitFor(() => expect(status()).toBe('执行中 │ 第 3/3 步'));
    expect(b.of('GET', '/agent/runs/run-8d03/items')).toHaveLength(1);
    const inline = () => thread.querySelector<HTMLElement>('[data-kind="task"]')!.textContent;
    expect(inline()).toMatch(/2\/3/);
    b.emit('plan', { run_id: 'run-8d03', conversation_id: C1, revision: 4, title: '周报', steps: [...steps.slice(0, 2), { text: '生成提交统计表', status: 'completed' }, { text: '自检', status: 'pending' }], status: 'in_progress', at: 0 });
    await waitFor(() => expect(status()).toBe('执行中 │ 第 4/4 步'));
    expect(inline()).toMatch(/3\/4/);
  });

  it('mock: the history conversation has as many turns as its row says', async () => {
    bridge();
    const c2 = WIRE_CONVERSATIONS.find((c) => c.id === C2)!;
    const { turns } = await get<{ turns: WireTurn[] }>(`/conversations/${C2}/turns`);
    expect(turns).toHaveLength(c2.turn_count);
  });

  it('opens the clicked historical task instead of the conversation’s active task', async () => {
    const active = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T1)!;
    const old = { ...active, canonical_task_id: 'character-old-qa', title: '较早的文稿校对', run_id: 'run-old-qa', state: 'succeeded', delivery: null, created_at: active.created_at - 10 };
    const b = bridge([{ method: 'GET', path: '/agent/tasks', handler: () => ({ status: 200, body: { tasks: [active, old], next_cursor: null } }) }]);
    const thread = await mount();
    fireEvent.click(await within(thread).findByRole('button', { name: /任务 较早的文稿校对/ }));
    const drawer = await screen.findByRole('complementary', { name: '任务' });
    expect(within(drawer).getByRole('heading', { name: '较早的文稿校对' })).toBeTruthy();
    expect(within(drawer).queryByRole('heading', { name: active.title })).toBeNull();
    expect(b.of('GET', '/agent/runs/run-old-qa/items').length).toBeGreaterThan(0);
  });

  it('refreshes tasks after background lifecycle updates and turns after unowned final notices', async () => {
    const b = bridge();
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    const tasks = () => b.of('GET', '/agent/tasks?conversation_id=').length;
    const turns = () => b.of('GET', `/conversations/${C1}/turns`).length;
    const tasksBefore = tasks();
    const turnsBefore = turns();
    b.emit('background_job', { job_id: 'bg-qa', state: 'needs_review' });
    b.emit('line', { line_id: 'job-report-qa', final: true, text_delta: '' });
    await waitFor(() => expect(tasks()).toBeGreaterThan(tasksBefore));
    await waitFor(() => expect(turns()).toBeGreaterThan(turnsBefore));
  });
});

const send = async (thread: HTMLElement, text: string) => {
  fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: text } });
  fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
};

const pick = (title: string) => fireEvent.click(within(topics()).getByText(title));

describe('chat review fixes', () => {
  it('a live reply stays in the conversation it was sent from', async () => {
    bridge();
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    await send(thread, '统计表好了吗？');
    await waitFor(() => expect(thread.querySelector('[data-live]')).toBeTruthy());
    pick('HostLink 断线排查');
    await within(thread).findByText(/超时阈值是 1.5 s/);
    expect(thread.querySelector('[data-live]')).toBeNull();
    expect(within(thread).queryByText('统计表好了吗？')).toBeNull();
    pick('周报整理');
    await waitFor(() => expect(thread.querySelector('[data-live]')).toBeTruthy());
  });

  it('an approval sends only the chosen option as its decision; no free text', async () => {
    const approval = { ...WIRE_INTERACTION_APPROVAL, conversation_id: C1, run_id: 'run-8d03' };
    const b = bridge([{ method: 'GET', path: '/agent/interactions', handler: () => ({ status: 200, body: { requests: [approval] } }) }]);
    const thread = await mount();
    const card = await waitFor(() => {
      const n = thread.querySelector<HTMLElement>('[data-kind="question"]');
      expect(n && within(n).queryByRole('option', { name: '允许' })).toBeTruthy();
      return n!;
    });
    expect(within(card).queryByRole('textbox')).toBeNull();
    const submit = within(card).getByRole('button', { name: '提交决定' });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    fireEvent.click(within(card).getByRole('option', { name: '允许' }));
    fireEvent.click(within(card).getByRole('button', { name: '提交决定' }));
    await waitFor(() => expect(b.of('POST', `/agent/interactions/${Q_APPROVAL}/answer`)).toHaveLength(1));
    expect(b.of('POST', `/agent/interactions/${Q_APPROVAL}/answer`)[0]!.body).toEqual({ expected_version: approval.revision, answers: { decision: ['允许'] } });
  });

  it('says why agentd refused an approval answer', () => {
    expect(reasonOf(new AgentdCallError(400, 'invalid_approval', undefined, { error: 'invalid_approval' }, 'x'))).toBe('审批只能选允许或拒绝');
    expect(reasonOf(new AgentdCallError(400, 'approval_expired', undefined, { error: 'approval_expired' }, 'x'))).toBe('审批已过期');
  });

  it('a line sent while a foreground run works is a side answer even with no task row', async () => {
    bridge([{ method: 'GET', path: '/agent/tasks', handler: () => ({ status: 200, body: { tasks: [], next_cursor: null } }) }]);
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    await send(thread, '统计表好了吗？');
    const side = await waitFor(() => {
      const n = thread.querySelector<HTMLElement>('[data-live] [data-kind="side"]');
      expect(n).toBeTruthy();
      return n!;
    });
    expect(within(side).getByText('只读')).toBeTruthy();
  });

  it('the gap note goes once the reply has landed in the turns', async () => {
    let landed = false;
    const reply: WireTurn = { ...WIRE_TURNS[WIRE_TURNS.length - 1]!, id: 999, turn_id: '7a1e5c0b9d24', user_text: '统计表好了吗？', reply: '统计表已生成。' };
    const b = bridge([{ method: 'GET', path: '/conversations/:id/turns', handler: () => ({ status: 200, body: { turns: landed ? [...WIRE_TURNS, reply] : WIRE_TURNS, before: null } }) }]);
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    await send(thread, '统计表好了吗？');
    await waitFor(() => expect(thread.querySelector('[data-live]')).toBeTruthy());
    b.reload();
    expect(await within(thread).findByText(/实时输出有中断/)).toBeTruthy();
    landed = true;
    b.reload();
    expect(await within(thread).findByText('统计表已生成。')).toBeTruthy();
    await waitFor(() => expect(within(thread).queryByText(/实时输出有中断/)).toBeNull());
  });

  it('a failed line and its 重发 do not follow to another conversation, and wait in their own', async () => {
    bridge();
    const thread = await mount('&demo=sendfail');
    expect(await within(thread).findByText(/发送失败/)).toBeTruthy();
    pick('HostLink 断线排查');
    await within(thread).findByText(/超时阈值是 1.5 s/);
    expect(within(thread).queryByText(/发送失败/)).toBeNull();
    pick('周报整理');
    await within(thread).findByText('按项目分组，不要按日期。');
    expect(within(thread).getByText(/发送失败/)).toBeTruthy();
  });
});

describe('chat writes', () => {
  it('sends {text} to the conversation, shows the side answer live and re-reads the turns at the final line', async () => {
    const b = bridge();
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: '统计表好了吗？' } });
    fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
    await waitFor(() => expect(b.of('POST', `/conversations/${C1}/messages`)).toHaveLength(1));
    expect(b.of('POST', `/conversations/${C1}/messages`)[0]!.body).toEqual({ text: '统计表好了吗？' });
    const side = await waitFor(() => {
      const n = thread.querySelector<HTMLElement>('[data-live] [data-kind="side"]');
      expect(n).toBeTruthy();
      return n!;
    });
    expect(within(side).getByText('只读')).toBeTruthy();
    const before = b.of('GET', `/conversations/${C1}/turns`).length;
    b.emit('line', { line_id: '7a1e5c0b9d24', text_delta: '还在算，', final: false, conversation_id: C1, run_id: '7a1e5c0b9d24' });
    b.emit('line', { line_id: '7a1e5c0b9d24', text_delta: '大约两分钟。', final: true, conversation_id: C1, run_id: '7a1e5c0b9d24', error: null, cancelled: false });
    expect(await within(side).findByText('还在算，大约两分钟。')).toBeTruthy();
    await waitFor(() => expect(b.of('GET', `/conversations/${C1}/turns`).length).toBe(before + 1));
  });

  /** `POST /conversations/{id}/messages` answering a deterministic command with 200 `body` (no line_id). */
  const command = (status: number, body: unknown): MockRoute => ({ method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status, body }) });
  const sendLine = async (text: string, routes: MockRoute[]) => {
    bridge(routes);
    const thread = await mount();
    await within(thread).findByText('按项目分组，不要按日期。');
    fireEvent.change(within(thread).getByRole('textbox', { name: '消息' }), { target: { value: text } });
    fireEvent.click(within(thread).getByRole('button', { name: /发送/ }));
    return thread;
  };

  it('a 提醒我 command shows the line and a local confirmation, with no pending reply', async () => {
    const due = NOW / 1000 + 600;
    const commitment = { id: 'c9', text: '喝水', due_at: due, state: 'armed', created_at: NOW / 1000, created_line: null, delivered_line: null, updated_at: NOW / 1000 };
    const thread = await sendLine('提醒我十分钟后喝水', [command(200, { command: 'remind', commitment })]);
    const pad = (n: number) => String(n).padStart(2, '0');
    const at = new Date(due * 1000);
    expect(await within(thread).findByText(`好，${pad(at.getHours())}:${pad(at.getMinutes())} 提醒你：喝水`)).toBeTruthy();
    const live = thread.querySelector<HTMLElement>('[data-live]')!;
    expect(within(live).getByText('提醒我十分钟后喝水')).toBeTruthy();
    expect(thread.querySelector('[data-live] [aria-live]')).toBeNull();
  });

  it('a 提醒我 command due on another day names the day before the clock time', async () => {
    const due = NOW / 1000 + 26 * 3600;
    const commitment = { id: 'c11', text: '交报告', due_at: due, state: 'armed', created_at: NOW / 1000, created_line: null, delivered_line: null, updated_at: NOW / 1000 };
    const thread = await sendLine('提醒我明天下午交报告', [command(200, { command: 'remind', commitment })]);
    const pad = (n: number) => String(n).padStart(2, '0');
    const at = new Date(due * 1000);
    expect(await within(thread).findByText(`好，${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())} 提醒你：交报告`)).toBeTruthy();
  });

  it('a 提醒我 command waiting for a session says what it waits for instead of a clock time', async () => {
    const commitment = { id: 'c10', text: '看结果', due_at: null, trigger: { kind: 'session_done', agent: 'claude' }, state: 'armed', created_at: NOW / 1000, created_line: null, delivered_line: null, updated_at: NOW / 1000 };
    const thread = await sendLine('Claude 做完提醒我看结果', [command(200, { command: 'remind', commitment })]);
    expect(await within(thread).findByText('好，等 claude 做完提醒你：看结果')).toBeTruthy();
  });

  it.each([
    [{ command: 'remember', fact_id: 'f1' }, '记住了'],
    [{ command: 'remember', fact_id: 'f1', reinforced: true }, '这条已经记着了'],
    [{ command: 'remember', fact_id: null, skipped: 'paused' }, '记忆已暂停，没记'],
    [{ command: 'remember', fact_id: null, skipped: 'no_memory' }, '这一轮不记，没记'],
    [{ command: 'mute' }, '好'],
  ])('a command answered with %j shows 「%s」 and no pending reply', async (body, note) => {
    const thread = await sendLine('记住我喜欢乌龙茶', [command(200, body)]);
    expect(await within(thread).findByText(note)).toBeTruthy();
    expect(thread.querySelector('[data-live] [aria-live]')).toBeNull();
  });

  it('a dispatch command shows 已开确认卡', async () => {
    const thread = await sendLine('让 Codex 跑一下测试', [command(202, { command: 'dispatch', request_id: 'r1' })]);
    expect(await within(thread).findByText('已开确认卡')).toBeTruthy();
    expect(thread.querySelector('[data-live] [aria-live]')).toBeNull();
  });

  it('a 409 no_reminder_time stays a failed send that says what was missing', async () => {
    const thread = await sendLine('提醒我', [command(409, { error: 'no_reminder_time' })]);
    expect(await within(thread).findByText(/没听清时间或要提醒的事/)).toBeTruthy();
    expect(thread.querySelector('[data-live]')).toBeNull();
  });

  it('stops the conversation run with {run_id, generation}', async () => {
    const b = bridge();
    await mount();
    await screen.findByText(/^执行中/);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '停止任务' }));
    await waitFor(() => expect(b.of('POST', `/conversations/${C1}/cancel`)).toHaveLength(1));
    expect(b.of('POST', `/conversations/${C1}/cancel`)[0]!.body).toEqual({ run_id: 'run-8d03', generation: 1 });
  });

  it('answers a question with {expected_version, answers} keyed by question id', async () => {
    const b = bridge();
    const thread = await mount();
    const card = await waitFor(() => {
      const n = thread.querySelector<HTMLElement>('[data-kind="question"]');
      expect(n?.querySelector('[data-stub="QuestionBox"]')).toBeTruthy();
      return n!;
    });
    fireEvent.click(within(card).getByRole('option', { name: '包含' }));
    fireEvent.click(within(card).getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(b.of('POST', `/agent/interactions/${Q1}/answer`)).toHaveLength(1));
    const q1 = WIRE_INTERACTIONS.find((q) => q.request_id === Q1)!;
    expect(b.of('POST', `/agent/interactions/${Q1}/answer`)[0]!.body).toEqual({ expected_version: q1.revision, answers: { scope: ['包含'] } });
    expect(await within(card).findByText('已回答：包含')).toBeTruthy();
  });

  it('renames, pins and archives with the row revision; undo sends the revision agentd returned', async () => {
    const b = bridge();
    await mount(`&demo=history&conv=${C2}`);
    await screen.findByText(/超时阈值是 1.5 s/);
    const c2 = WIRE_CONVERSATIONS.find((c) => c.id === C2)!;
    menu('HostLink 断线排查', /重命名/);
    const box = within(topics()).getByRole('textbox', { name: '话题名' });
    fireEvent.change(box, { target: { value: 'HostLink 心跳' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await within(topics()).findByText('HostLink 心跳');
    menu('HostLink 心跳', '置顶');
    await waitFor(() => expect(rowOf('HostLink 心跳').textContent).toMatch(/置顶$/));
    menu('HostLink 心跳', '归档');
    await waitFor(() => expect(b.of('PUT', `/conversations/${C2}`)).toHaveLength(3));
    // agentd counts the revision up on every write.
    expect(b.of('PUT', `/conversations/${C2}`).map((c) => c.body)).toEqual([
      { expected_version: c2.revision, title: 'HostLink 心跳' },
      { expected_version: c2.revision + 1, pinned: true },
      { expected_version: c2.revision + 2, archived: true },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() => expect(b.of('PUT', `/conversations/${C2}`)).toHaveLength(4));
    expect(b.of('PUT', `/conversations/${C2}`)[3]!.body).toEqual({ expected_version: c2.revision + 3, archived: false });
  });

  it('deletes with a JSON body and continues a history conversation through activate', async () => {
    const b = bridge([idleList]);
    await mount(`&demo=history&conv=${C2}`);
    await screen.findByText(/超时阈值是 1.5 s/);
    const c2 = WIRE_CONVERSATIONS.find((c) => c.id === C2)!;
    fireEvent.click(screen.getByRole('button', { name: '继续此对话' }));
    await waitFor(() => expect(b.of('POST', `/conversations/${C2}/activate`)).toHaveLength(1));
    expect(b.of('POST', `/conversations/${C2}/activate`)[0]!.body).toEqual({ expected_version: c2.revision });
    menu('HostLink 断线排查', /删除/);
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除「HostLink 断线排查」？' })).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(b.of('DELETE', `/conversations/${C2}`)).toHaveLength(1));
    expect(b.of('DELETE', `/conversations/${C2}`)[0]!.body).toEqual({ expected_version: c2.revision });
  });

  it('a version conflict says 已在别处更新 and re-reads the list', async () => {
    const b = bridge([{ method: 'PUT', path: '/conversations/:id', handler: () => ({ status: 409, body: { error: 'version_conflict' } }) }]);
    await mount(`&demo=history&conv=${C2}`);
    await screen.findByText(/超时阈值是 1.5 s/);
    const reads = () => b.of('GET', '/conversations?character=si').length;
    const before = reads();
    menu('HostLink 断线排查', '置顶');
    expect(await screen.findByText('没有置顶：已在别处更新')).toBeTruthy();
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});

describe('chat actions', () => {
  const t1 = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T1)!;

  /** agentd's task decision and resume routes; the task page's mock registers them. */
  const decided: MockRoute[] = ['/agent/tasks/:id/accept', '/agent/tasks/:id/reject', '/agent/jobs/:id/resume'].map((path) => ({ method: 'POST', path, handler: () => ({ status: 200, body: {} }) }));

  async function actionsWith(over: Partial<ChatDeps> = {}, routes: MockRoute[] = []) {
    const b = bridge([...decided, ...routes]);
    const pushes: string[] = [];
    const { fromConversation, fromTaskRow, fromDelivery } = await import('../../src/domain');
    const task = fromTaskRow(t1);
    const delivery = fromDelivery(t1.delivery!);
    const deps: ChatDeps = {
      conv: fromConversation(WIRE_CONVERSATIONS[0]!, NOW),
      character: 'si',
      present: 'si',
      askSwap: async () => true,
      shown: () => null,
      task,
      run: null,
      view: { tasks: [task], deliveries: [delivery], pending: [], activeRuns: {}, sessions: [], ctx: { activeRuns: {}, sessions: [], pending: [] }, effective: {}, waiting: { tasks: 0, items: 0 }, goals: [] },
      busy: false,
      setLocal: () => {},
      setAnswered: () => {},
      setCancelled: () => {},
      setFailed: () => {},
      setSending: () => {},
      setBusyDecide: () => {},
      setNotice: () => {},
      select: () => {},
      editTitle: () => {},
      addReply: () => {},
      settleReply: () => {},
      reload: { list: () => {}, turns: () => {}, tasks: () => {}, present: () => {}, runtime: async () => undefined },
      push: (m) => void pushes.push(m),
      failSend: false,
      ...over,
    };
    return { b, a: createChatActions(deps), deliveryBody: { expected_revision: delivery.revision, generation: delivery.generation, delivery_id: delivery.id }, pushes };
  }

  it('accepts and rejects through /agent/tasks/{cid}; a reject note resumes the job', async () => {
    const { b, a, deliveryBody } = await actionsWith();
    await a.onDrawer({ kind: 'accept', deliveryId: deliveryBody.delivery_id });
    await a.onDrawer({ kind: 'reject', deliveryId: deliveryBody.delivery_id, note: '加上外部会话', useCurrentKernel: true });
    expect(b.of('POST', `/agent/tasks/${T1}/accept`)[0]!.body).toEqual(deliveryBody);
    expect(b.of('POST', `/agent/tasks/${T1}/reject`)[0]!.body).toEqual(deliveryBody);
    expect(b.of('POST', `/agent/jobs/${t1.job_id}/resume`)[0]!.body).toEqual({ text: '加上外部会话', use_current_backend: true });
  });

  it('queues a side answer as POST /agent/jobs {title, text}', async () => {
    const { b, a } = await actionsWith();
    await a.queueSide('顺便查下 HostLink 断线是哪次提交引入的？');
    expect(b.of('POST', '/agent/jobs')[0]!.body).toEqual({ title: '顺便查下 HostLink 断线…', text: '顺便查下 HostLink 断线是哪次提交引入的？' });
  });

  it('dismisses a question with {expected_version}', async () => {
    const { b, a } = await actionsWith();
    const { fromInteraction } = await import('../../src/domain');
    const q = fromInteraction(WIRE_INTERACTIONS[0]!, NOW);
    await a.dismiss(q);
    expect(b.of('POST', `/agent/interactions/${Q1}/dismiss`)[0]!.body).toEqual({ expected_version: q.revision });
  });

  it('a first line with no conversation opens one for her character with POST /conversations {character_id}', async () => {
    const { b, a } = await actionsWith({ conv: null });
    await a.send('你好');
    expect(b.of('POST', '/conversations').map((c) => [c.path, c.body])[0]).toEqual(['/conversations', { character_id: 'si' }]);
  });

  it.each([
    ['no_task', '现在没有在跑的任务'],
    ['ambiguous_task', '有多个任务在跑，请在任务页选一个停下'],
    ['no_cwd', '没有工作目录：先在会话里打开一个目录'],
    ['no_memory_dispatch', '这一轮不记，不能派活'],
    ['switching', '正在换角色，稍后再说'],
    ['no_reminder_time', '没听清时间或要提醒的事'],
    ['no_pending_approval', '没有待决的审批'],
    ['ambiguous_approval', '有多张审批卡，请在卡片上选一张拒绝'],
    ['scope_changed', '工作目录已变动或不可用'],
    ['scope_revoked', '工作目录授权已撤销'],
    ['scope_expired', '工作目录授权已过期'],
    ['unknown_scope', '工作目录授权不存在'],
    ['idempotency_conflict', '同一请求已用不同内容发过'],
  ])('a 409 %s on send says 「%s」 and does not re-read the list', async (code, text) => {
    const failed: string[] = [];
    let lists = 0;
    const { a } = await actionsWith(
      { setFailed: (f) => void (f && failed.push(f.reason)), reload: { list: () => void lists++, turns: () => {}, tasks: () => {}, present: () => {}, runtime: async () => undefined } },
      [{ method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 409, body: { error: code } }) }],
    );
    await a.send('停下');
    expect(failed).toEqual([text]);
    expect(lists).toBe(0);
  });

  it('a 409 conflict on send still re-reads the list', async () => {
    let lists = 0;
    const { a } = await actionsWith(
      { reload: { list: () => void lists++, turns: () => {}, tasks: () => {}, present: () => {}, runtime: async () => undefined } },
      [{ method: 'POST', path: '/conversations/:id/messages', handler: () => ({ status: 409, body: { error: 'version_conflict' } }) }],
    );
    await a.send('你好');
    expect(lists).toBe(1);
  });

  it('says 后台已断开 only for offline, 已在别处更新 for a conflict', () => {
    expect(reasonOf(new AgentdCallError(0, 'offline', undefined, null, 'offline'))).toBe('后台已断开');
    expect(reasonOf(new AgentdCallError(409, 'version_conflict', undefined, { error: 'version_conflict' }, 'x'))).toBe('已在别处更新');
    expect(reasonOf(new AgentdCallError(0, 'route_class', undefined, null, 'x'))).toBe('后台拒绝了这次操作');
    expect(reasonOf(new AgentdCallError(503, 'native_login_required', undefined, { error: 'native_login_required', runtime: 'codex' }, 'x'))).toBe('角色内核未就绪');
  });
});

describe('chat stream', () => {
  it('places role tasks and requests at their creation time among the turns', () => {
    const msgs = chatStream(
      [
        { kind: 'me', at: 10, text: 'a' },
        { kind: 'ai', at: 20, text: 'b', turn_ms: 10 },
        { kind: 'me', at: 30, text: 'c' },
      ],
      [{ id: T1, created_at: 15 } as never],
      [{ id: Q1, since: 40 } as never],
    );
    expect(msgs.map((m) => m.kind)).toEqual(['me', 'task', 'ai', 'me', 'question']);
  });
});
