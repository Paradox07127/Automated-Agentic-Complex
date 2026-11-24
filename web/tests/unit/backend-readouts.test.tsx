import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../src/bridge';
import { AgentdCallError } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse } from '../../src/bridge/protocol';
import { failText, loadTasksBase, TasksLoadError } from '../../src/data/tasksBase';
import { fromApproval, fromLedgerTask, type Task, type WireLedgerTask, type WireTaskRow } from '../../src/domain';
import { verifyText } from '../../src/domain/errorText';
import { ApprovalCard, dangerRuleText } from '../../src/features/approval';
import { APPROVALS, NOW, pick, TASKS, WIRE_APPROVALS, WIRE_DELIVERIES, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { A1, DLV_T1_V1, DLV_T1_V2, T1, T6 } from '../../src/mock/fixtures/ids';
import { createChatActions, type ChatDeps } from '../../src/pages/chat/actions';
import { Composer, type ComposerProps } from '../../src/pages/chat/Composer';
import { runEndLabel } from '../../src/pages/chat/stream';
import { loadError } from '../../src/pages/chat/useChatData';
import { reminderTime } from '../../src/pages/overview/briefModel';
import { createTasksActions, failMessage, type ActionDeps } from '../../src/pages/tasks/actions';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import { useSessionLines, watchTasksDiag, watchTasksFeed } from '../../src/pages/tasks/useTasksData';
import { mountTaskDetail } from './taskDetailMount';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake bridge as `window.agenticComplex` whose agentd answers `override(path)` when it returns a response, recording every request. */
function install(override: (path: string) => AgentdResponse<unknown> | null = () => null) {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  const real = bridge.agentd.request.bind(bridge.agentd);
  const calls: Call[] = [];
  vi.spyOn(bridge.agentd, 'connection').mockResolvedValue('connected');
  vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
    calls.push({ method, path, body });
    return (override(path) ?? (await real(method, path, body))) as never;
  });
  window.agenticComplex = bridge;
  return { bridge, calls };
}

const ledger = (over: Partial<WireLedgerTask>): WireLedgerTask => ({
  task_id: '9c0d1e2f3a4b5c6d',
  target: 'codex',
  cwd: '/Users/me/Endfield/app',
  title: '修 HostLink 重连测试',
  mode: 'workspace_write',
  state: 'failed',
  verify_cmd: 'swift test --filter HostLinkTests',
  session_id: null,
  created_at: NOW / 1000 - 600,
  updated_at: NOW / 1000 - 60,
  result: null,
  ...over,
});

describe('chat run end', () => {
  it('needs_review reads 待复核, not a plain 已完成', () => {
    expect(runEndLabel('completed', 'needs_review')).toBe('已完成 │ 待复核');
  });
});

describe('danger rules', () => {
  it('every danger.py code has a Chinese label; an unknown one gets a generic sentence', () => {
    for (const code of ['sudo', 'pipe_to_shell', 'rm_recursive', 'recursive_permissions', 'disk', 'find_delete', 'git_force_push', 'git_discard', 'sensitive_path']) {
      const text = dangerRuleText(code);
      expect(text).not.toContain(code);
      expect(text).toMatch(/[一-鿿]/);
    }
    expect(dangerRuleText('brand_new_rule')).toBe('命中危险规则');
  });

  it('the approval card shows the label, the code only as a tooltip', () => {
    const a = { ...pick(APPROVALS, A1), dangerous: true, danger_rule: 'git_force_push' };
    const { container } = render(<ApprovalCard approval={a} />);
    expect(container.textContent).toContain('强制推送');
    expect(container.textContent).not.toContain('git_force_push');
  });

  it('the wire fixture uses a real danger.py code', () => {
    expect(WIRE_APPROVALS.find((a) => a.request_id === A1)?.danger_rule).toBe('rm_recursive');
    expect(fromApproval(WIRE_APPROVALS.find((a) => a.request_id === A1)!, NOW).danger_rule).toBe('rm_recursive');
  });
});

describe('reminder time', () => {
  const day = new Date(NOW);
  const at = (d: number, h: number, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, h, m).getTime();
  it('today HH:MM, tomorrow 明天 HH:MM, later M/D HH:MM', () => {
    expect(reminderTime(at(0, 16, 30), NOW)).toBe('16:30');
    expect(reminderTime(at(1, 8, 0), NOW)).toBe('明天 08:00');
    const later = new Date(at(3, 9, 5));
    expect(reminderTime(later.getTime(), NOW)).toBe(`${later.getMonth() + 1}/${later.getDate()} 09:05`);
  });
});

describe('error codes in banners and toasts', () => {
  it('a bridge refusal reads as a sentence, the code kept apart', async () => {
    expect(failText({ status: 0, body: null, error: { code: 'route_class' } })).not.toContain('route_class');
    install((path) => (path === '/sessions' ? { status: 400, body: null, error: { code: 'weird_code' } } : null));
    const e = await loadTasksBase(false, { sessions: true, agent: true }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TasksLoadError);
    expect((e as TasksLoadError).message).not.toContain('weird_code');
    expect((e as TasksLoadError).code).toBe('weird_code');
  });
  it('chat load errors name no code', () => {
    const e = loadError(new AgentdCallError(400, 'invalid_query', undefined, null, 'invalid_query'), 'connected', '读取对话失败');
    expect(e.message).toBe('读取对话失败：后台不接受这次查询');
    const u = loadError(new AgentdCallError(500, 'mystery', undefined, null, 'mystery'), 'connected', '读取对话失败');
    expect(u.message).not.toContain('mystery');
    expect(u.code).toBe('mystery');
  });
  it('a write failing with an unmapped code toasts a sentence, not the code', () => {
    const text = failMessage(new AgentdCallError(500, 'mystery_code', undefined, null, 'mystery_code'));
    expect(text).not.toContain('mystery_code');
    expect(text).toMatch(/[一-鿿]/);
    expect(failMessage(new AgentdCallError(503, 'character_runtime_unavailable', undefined, null, ''))).toBe('角色内核没有启动');
  });
});

describe('coding task verify result', () => {
  it('the ledger result reaches the task', () => {
    const t = fromLedgerTask(ledger({ result: { exit_code: 2, output_tail: 'error: HostLinkTests failed', reason: null } }));
    expect(t.verify).toEqual({ exit_code: 2, output_tail: 'error: HostLinkTests failed', reason: null });
  });
  it('the detail shows the reason in words, the exit code and the folded output', () => {
    const t = fromLedgerTask(ledger({ result: { exit_code: 2, output_tail: 'error: HostLinkTests failed', reason: null } }));
    const { container } = mountTaskDetail(t);
    const sec = container.querySelector('section[aria-label="检查"]');
    expect(sec?.textContent).toContain('检查没通过');
    expect(sec?.textContent).toContain('退出码 2');
    expect(sec?.textContent).not.toContain('HostLinkTests failed');
  });
  it('no_verify_cmd reads as a sentence, once, on the 验收 paper', () => {
    const t = fromLedgerTask(ledger({ state: 'needs_review', result: { exit_code: null, output_tail: null, reason: 'no_verify_cmd', delivery_id: 'delivery-9c0d1e2f3a4b5c6d9c0d1e2f3a4b5c6d' } }));
    const { container } = mountTaskDetail(t);
    expect((container.textContent ?? '').match(/没有设置检查命令/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('no_verify_cmd');
    expect(screen.getByRole('heading', { name: '验收编码结果' }).parentElement?.textContent).toContain('结果待复核');
  });
  it.each(['succeeded', 'failed'] as const)('a %s task without a verify command says nothing about review', (state) => {
    const t = fromLedgerTask(ledger({ state, result: { exit_code: null, output_tail: null, reason: 'no_verify_cmd' } }));
    const { container } = mountTaskDetail(t);
    expect(container.querySelector('section[aria-label="检查"]')).toBeNull();
    expect(container.textContent).not.toContain('待复核');
  });
  it('a cancelled task shows no 检查 section, and an interrupted turn never reads as a restart', () => {
    expect(verifyText({ exit_code: null, reason: 'interrupted' })).not.toContain('重启');
    const t = fromLedgerTask(ledger({ state: 'cancelled', result: { exit_code: null, output_tail: null, reason: 'interrupted' } }));
    const { container } = mountTaskDetail(t);
    expect(container.querySelector('section[aria-label="检查"]')).toBeNull();
    expect(container.textContent).not.toContain('重启');
  });
});

describe('task reads follow next_cursor', () => {
  it('reads every /agent/tasks page and every /agent/deliveries page', async () => {
    const t6 = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T6)!;
    const rest = WIRE_TASK_ROWS.filter((r) => r !== t6);
    const t1 = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T1)!;
    // While v2 reruns, the row carries no delivery: v1 is reachable only through /agent/deliveries.
    const rows: WireTaskRow[] = rest.map((r) => (r === t1 ? { ...r, delivery: null } : r));
    const v1 = WIRE_DELIVERIES.find((d) => d.delivery_id === DLV_T1_V1)!;
    const v2 = WIRE_DELIVERIES.find((d) => d.delivery_id === DLV_T1_V2)!;
    const { calls } = install((path) => {
      if (path === '/agent/tasks?limit=100') return { status: 200, body: { tasks: rows, next_cursor: 'p2' } };
      if (path === '/agent/tasks?limit=100&cursor=p2') return { status: 200, body: { tasks: [t6], next_cursor: null } };
      if (path === '/agent/deliveries?limit=100') return { status: 200, body: { deliveries: [v2], next_cursor: 'd2' } };
      if (path === '/agent/deliveries?limit=100&cursor=d2') return { status: 200, body: { deliveries: [v1], next_cursor: null } };
      return null;
    });
    const base = await loadTasksBase(false, { sessions: true, agent: true });
    expect(base.tasks.some((t) => t.id === T6)).toBe(true);
    expect(base.deliveries.filter((d) => d.task_id === T1).map((d) => d.id).sort()).toEqual([DLV_T1_V1, DLV_T1_V2].sort());
    expect(calls.some((c) => c.path === '/agent/deliveries?limit=100&cursor=d2')).toBe(true);
  });

  it('only the row’s current delivery can be a review', () => {
    const t1 = pick(TASKS, T1);
    const old = { ...t1.delivery!, id: 'delivery-old' as never, version: 1, generation: 0, decided_at: null, state: 'viewed' as const };
    const view = deriveView({ tasks: [t1], deliveries: [t1.delivery!, old], sessions: [], approvals: [], questions: [], goals: [], activeRuns: {}, roleMissing: false }, emptyLocal());
    expect(view.pending.filter((p) => p.kind === 'review').map((p) => p.id)).toEqual([`r-${t1.delivery!.id}`]);
  });
});

describe('coding review in the main window', () => {
  const review: Task = { ...fromLedgerTask(ledger({ state: 'needs_review', result: { exit_code: null, output_tail: null, reason: 'no_verify_cmd', delivery_id: 'delivery-9c0d1e2f3a4b5c6d9c0d1e2f3a4b5c6d' } })) };

  it('the detail offers 验收 and 驳回, each sent to the ledger task', async () => {
    const { calls } = install((path) => (path.startsWith('/tasks/') ? { status: 200, body: { task: {} } } : null));
    mountTaskDetail(review);
    fireEvent.click(screen.getByRole('button', { name: '验收' }));
    fireEvent.click(screen.getByRole('button', { name: '驳回' }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/tasks/${review.task_id}/accept`, `/tasks/${review.task_id}/reject`]));
  });

  it('the inbox lists it', () => {
    const view = deriveView({ tasks: [review], deliveries: [], sessions: [], approvals: [], questions: [], goals: [], activeRuns: {}, roleMissing: false }, emptyLocal());
    expect(view.pending.some((p) => p.kind === 'review' && p.task_id === review.id)).toBe(true);
  });

  it('POSTs /tasks/{ledger id}/accept with no body', async () => {
    const { calls } = install((path) => (path.startsWith('/tasks/') ? { status: 200, body: { task: {} } } : null));
    const view = deriveView({ tasks: [review], deliveries: [], sessions: [], approvals: [], questions: [], goals: [], activeRuns: {}, roleMissing: false }, emptyLocal());
    const pushes: string[] = [];
    const deps: ActionDeps = {
      view,
      setLocal: () => {},
      push: (m) => void pushes.push(m),
      order: [],
      select: () => {},
      failCode: null,
      setDecideFail: () => {},
      setBusy: () => {},
      askStop: () => {},
      retrySteps: () => {},
      reload: () => {},
      now: () => NOW,
      nativeOff: () => {},
    };
    await createTasksActions(deps).review(review, 'accept');
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: `/tasks/${review.task_id}/accept`, body: undefined });
    expect(pushes[0]).toContain('已验收');
  });
});

describe('chat composer look / no_memory', () => {
  const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({
    roleName: '角色',
    history: false,
    busy: false,
    kernel: null,
    failed: null,
    sending: false,
    onSend: async () => 'sent' as const,
    onResend: () => {},
    onDiscardFailed: () => {},
    onContinue: () => {},
    onRecheck: () => {},
    ...over,
  });

  it('the toggles go out with the text', () => {
    const onSend = vi.fn();
    render(<Composer {...props({ onSend })} />);
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '帮我看一下这个报错' } });
    fireEvent.click(screen.getByRole('button', { name: '附加' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '让角色看一眼屏幕' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '这句不记' }));
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).toHaveBeenLastCalledWith('帮我看一下这个报错', { look: true, no_memory: true });
  });

  it('send posts look and no_memory only when on', async () => {
    const { calls } = install();
    const { fromConversation } = await import('../../src/domain');
    const { WIRE_CONVERSATIONS } = await import('../../src/mock/fixtures');
    const deps: ChatDeps = {
      conv: fromConversation(WIRE_CONVERSATIONS[0]!, NOW),
      character: 'si',
      present: 'si',
      askSwap: async () => true,
      shown: () => null,
      task: null,
      run: null,
      view: null,
      busy: false,
      setLocal: () => {},
      setAnswered: () => {},
      setCancelled: () => {},
      setFailed: () => {},
      dropFailed: () => {},
      setSending: () => {},
      setBusyDecide: () => {},
      setNotice: () => {},
      select: () => {},
      editTitle: () => {},
      addReply: () => {},
      settleReply: () => {},
      reload: { list: () => {}, turns: () => {}, tasks: () => {}, present: () => {}, runtime: async () => undefined },
      push: () => {},
      failSend: false,
    };
    const a = createChatActions(deps);
    await a.send('看下这个', { look: true, no_memory: false });
    await a.send('不用记', { look: false, no_memory: true });
    const posts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages')).map((c) => c.body);
    expect(posts).toEqual([
      { text: '看下这个', look: true },
      { text: '不用记', no_memory: true },
    ]);
  });
});

describe('tasks page hears the diag stream', () => {
  it('reloads on an approval decision and on a change of the sessions block', () => {
    let onEvent: ((e: StreamEvent) => void) | null = null;
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = { ...bridge, diag: { subscribe: (e: (x: StreamEvent) => void) => ((onEvent = e), () => {}) } } as never;
    const onChange = vi.fn();
    watchTasksDiag(onChange);
    const emit = (event: string, data: unknown) => onEvent?.({ event, id: null, data: JSON.stringify(data) });
    emit('decision', { kind: 'approval.decided' });
    expect(onChange).toHaveBeenCalledTimes(1);
    emit('decision', { kind: 'gate.allow' });
    emit('state', { sessions: { sessions: [], updated_at: 'a' }, budget: { updated_at: 'a' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    emit('state', { sessions: { sessions: [], updated_at: 'a' }, budget: { updated_at: 'b' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    emit('state', { sessions: { sessions: [{}], updated_at: 'c' }, budget: { updated_at: 'b' } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reloads the rows when a coding dispatch announces its end after the verify command', () => {
    let onEvent: ((e: StreamEvent) => void) | null = null;
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.agenticComplex = { ...bridge, feed: { subscribe: (e: (x: StreamEvent) => void) => ((onEvent = e), () => {}) } } as never;
    const onChange = vi.fn();
    watchTasksFeed(() => {}, onChange, () => false);
    onEvent!({ event: 'announce', id: null, data: JSON.stringify({ kind: 'reminder_due', level: 'P2' }) });
    expect(onChange).not.toHaveBeenCalled();
    onEvent!({ event: 'announce', id: null, data: JSON.stringify({ kind: 'dispatch_review', level: 'P2' }) });
    expect(onChange).toHaveBeenLastCalledWith('base');
  });
});

describe('running coding session transcript is polled', () => {
  it('reads the lines again while the session runs', async () => {
    vi.useFakeTimers();
    const { calls } = install();
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(() => useSessionLines('own:c07a1b2c3d4e', 0), { wrapper });
    const reads = () => calls.filter((c) => c.path.startsWith('/sessions/own:c07a1b2c3d4e/lines')).length;
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(reads()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(reads()).toBeGreaterThan(1);
    client.clear();
  });
});
