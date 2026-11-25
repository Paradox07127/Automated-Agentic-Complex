// 任务页右侧详情：审批纸在她停住的那一步里、放开范围的说法按任务种类、Esc 不拒绝、复核、失败原因、版本链和「回到上一版」。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { Approval, Question } from '../../src/domain';
import { APPROVALS, DELIVERIES, GOALS, NOW, pick, QUESTIONS, TASKS } from '../../src/mock/fixtures';
import { A2, DLV_T1_V1, DLV_T1_V2, Q1, S_C07A, T1, T2, T3, T6 } from '../../src/mock/fixtures/ids';
import { createTasksActions, type ActionDeps } from '../../src/pages/tasks/actions';
import { Artifacts } from '../../src/pages/tasks/Artifacts';
import { BottomBar, type BottomBarProps } from '../../src/pages/tasks/Bottom';
import { CreateDialog } from '../../src/pages/tasks/CreateDialog';
import { draftFor } from '../../src/pages/tasks/CreateForm';
import { deriveView, emptyLocal, type TasksView } from '../../src/pages/tasks/model';
import { ApprovalPaper } from '../../src/pages/tasks/Papers';
import { TaskDetail } from '../../src/pages/tasks/TaskDetail';
import { TaskDrawer } from '../../src/features/task';
import type { TaskDesk } from '../../src/pages/tasks/useTaskDesk';
import type { TasksBase } from '../../src/pages/tasks/useTasksData';

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noop = () => {};
const OWN = { id: S_C07A, task_id: T2, kind: 'code' as const, own: true, target: 'codex' as const, display_session: null, agent: 'Codex', title: 'companion', state: 'running' as const, since: NOW, cwd: '~/Endfield/app' };
/** A role call approval of T3 that may be let through for the rest of the task. */
const ROLE_ASK: Question & { interaction_kind: 'approval' } = { ...pick(QUESTIONS, Q1), id: 'q-role-ask', task_id: T3, conversation_id: null, interaction_kind: 'approval', approval_answers: ['allow', 'allow_session', 'deny'], preview_text: '{"tool": "read_file"}' };

function view(over: Partial<TasksBase> = {}): TasksView {
  const base: TasksBase = { tasks: TASKS, deliveries: DELIVERIES, sessions: [OWN], approvals: APPROVALS, questions: QUESTIONS, goals: GOALS, activeRuns: {}, roleMissing: false, ...over };
  return deriveView(base, emptyLocal());
}

function deps(v: TasksView): ActionDeps {
  return { view: v, setLocal: vi.fn(), push: vi.fn(), order: [], select: vi.fn(), failCode: null, setDecideFail: vi.fn(), setBusy: vi.fn(), askStop: vi.fn(), retrySteps: vi.fn(), reload: vi.fn(), now: () => NOW, nativeOff: vi.fn() };
}

function mount(id: string, v: TasksView = view()) {
  const d = deps(v);
  const desk = { view: v, actions: createTasksActions(d), local: emptyLocal(), receipt: vi.fn(), kernel: { data: '默认内核' }, now: NOW, push: d.push, retry: 0, busy: false, decideFail: null, nativeOff: {} } as unknown as TaskDesk;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TaskDetail task={pick(v.tasks, id)} desk={desk} who="陈千语" convTitle={() => null} onGoChat={noop} note={false} onNote={noop} />
    </QueryClientProvider>,
  );
}

describe('task detail: a decision sits in the step she waits on', () => {
  it('a coding session approval offers 这次会话都允许; a role task approval offers 这个任务里都允许', () => {
    const scoped = APPROVALS.map((a) => (a.id === A2 ? { ...a, scope_ok: true, dangerous: false, options: ['allow', 'allow_session', 'deny'] as Approval['options'] } : a));
    const code = mount(T2, view({ approvals: scoped }));
    const paper = code.container.querySelector('[data-focus-card]') as HTMLElement;
    expect(paper.closest('[data-s="waiting"], [data-s="in_progress"]')).not.toBeNull();
    expect(within(paper).getByRole('button', { name: '当前会话均允许' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '当前任务均允许' })).toBeNull();
    cleanup();
    mount(T3, view({ questions: [...QUESTIONS, ROLE_ASK] }));
    expect(screen.getByRole('button', { name: '当前任务均允许' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '当前会话均允许' })).toBeNull();
  });

  it('a role approval whose run belongs to a conversation offers 本对话都允许, the grant agentd keys by conversation', () => {
    mount(T3, view({ questions: [...QUESTIONS, { ...ROLE_ASK, conversation_id: 'conv-1' }] }));
    expect(screen.getByRole('button', { name: '当前对话均允许' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '当前任务均允许' })).toBeNull();
  });

  it('Esc on an approval paper denies nothing; ⏎ approves, and on a dangerous call it only says to use the mouse', () => {
    const onDecide = vi.fn();
    const onMouseOnly = vi.fn();
    const { container, rerender } = render(<ApprovalPaper item={ROLE_ASK} kernelName="默认内核" scopeLabel="这个任务里都允许" onDecide={onDecide} onMouseOnly={onMouseOnly} />);
    const paper = container.querySelector('[data-focus-card]') as HTMLElement;
    fireEvent.keyDown(paper, { key: 'Escape' });
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.keyDown(paper, { key: 'Enter' });
    expect(onDecide).toHaveBeenLastCalledWith('allow', undefined);
    rerender(<ApprovalPaper item={{ ...ROLE_ASK, dangerous: true }} kernelName="默认内核" scopeLabel="这个任务里都允许" onDecide={onDecide} onMouseOnly={onMouseOnly} />);
    fireEvent.keyDown(container.querySelector('[data-focus-card]') as HTMLElement, { key: 'Enter' });
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onMouseOnly).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '当前任务均允许' })).toBeNull();
  });

  it('a version waiting for review is one paper with 接受 v2 as the yellow button; an open question takes the yellow instead', () => {
    const alone = mount(T1, view({ questions: [] }));
    const accept = screen.getByRole('button', { name: '接受 v2' });
    const paper = accept.closest('[data-theme="light"]') as HTMLElement;
    expect([...alone.container.querySelectorAll('[data-variant="primary"]')]).toEqual([accept]);
    expect(within(paper).getByRole('button', { name: /^驳回/ })).toBeTruthy();
    cleanup();
    const asked = mount(T1);
    expect(screen.getByRole('button', { name: '接受 v2' }).getAttribute('data-variant')).not.toBe('primary');
    expect(asked.container.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  });

  it('a failed task leads with its reason in the red band and keeps its steps', () => {
    const { container } = mount(T6);
    const scroll = container.querySelector('[data-detail-scroll]') as HTMLElement;
    expect(scroll.firstElementChild?.getAttribute('role')).toBe('status');
    expect(scroll.firstElementChild?.textContent).toContain('资料授权已撤销');
    expect(container.textContent).not.toContain('/agent/tasks');
  });
});

describe('task detail: notes and messages', () => {
  const bottom = (task: TasksView['tasks'][number], v: TasksView) => {
    const desk = { view: v, actions: createTasksActions(deps(v)), local: emptyLocal(), nativeOff: {} } as unknown as TaskDesk;
    const p = { tab: 'run', empty: false, newLabel: '派发任务', onNew: noop, draft: null, problem: null, busy: false, onCancel: noop, onSubmit: noop, task, desk, dev: false, schedule: null, onNote: noop, onAgain: noop, onGoChat: noop, onEdit: noop, onRunNow: noop, onDelete: noop } as unknown as BottomBarProps;
    return render(<BottomBar {...p} />);
  };

  it('a running role job offers no 补一句, which agentd would refuse as job_not_resumable; a job waiting on her question does', () => {
    const v = view();
    const t3 = pick(v.tasks, T3);
    bottom({ ...t3, status: 'running' }, v);
    expect(screen.queryByRole('button', { name: /补充说明/ })).toBeNull();
    cleanup();
    bottom({ ...t3, status: 'waiting_user' }, v);
    expect(screen.getByRole('button', { name: /补充说明/ })).toBeTruthy();
  });

  it('a message the coding session refused stays in the field', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const real = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
      (path.endsWith('/messages') ? { status: 409, body: { error: 'busy' }, error: { code: 'busy' } } : await real(method, path, body)) as never);
    window.agenticComplex = bridge;
    mount(T2);
    const field = screen.getByRole('textbox', { name: '给编码会话发消息' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '先跑测试' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(bridge.agentd.request).toHaveBeenCalledWith('POST', `/sessions/${S_C07A}/messages`, { text: '先跑测试' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(field.value).toBe('先跑测试');
  });

  it('text typed while a message is being sent stays when the send lands', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const real = bridge.agentd.request.bind(bridge.agentd);
    let land: (r: unknown) => void = () => {};
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) =>
      (path.endsWith('/messages') ? await new Promise<unknown>((r) => (land = r)) : await real(method, path, body)) as never);
    window.agenticComplex = bridge;
    mount(T2);
    const field = screen.getByRole('textbox', { name: '给编码会话发消息' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '先跑测试' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(bridge.agentd.request).toHaveBeenCalledWith('POST', `/sessions/${S_C07A}/messages`, { text: '先跑测试' }));
    fireEvent.change(field, { target: { value: '再看日志' } });
    land({ status: 202, body: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(field.value).toBe('再看日志');
  });
});

describe('task detail: 在对话轮次里看', () => {
  it("opens the task's own turn in 诊断 › 对话轮次, and the turn list when the task has no run", async () => {
    const v = view();
    const task = v.tasks.find((t) => t.run_id && !v.activeRuns[t.id])!;
    await createTasksActions(deps(v)).onTask(task)({ kind: 'open_timeline' });
    expect(window.location.hash).toBe(`#/diag?${new URLSearchParams({ tab: 'turns', turn: task.run_id! })}`);
    await createTasksActions(deps(v)).onTask({ ...task, run_id: null })({ kind: 'open_timeline' });
    expect(window.location.hash).not.toContain('turn=');
    expect(window.location.hash).toContain('#/diag?tab=turns');
  });
});

describe('task detail: 产物', () => {
  const both = [pick(DELIVERIES, DLV_T1_V1), pick(DELIVERIES, DLV_T1_V2)];

  it('the version chain, folded under 版本, names each version and its verdict, and picks the one shown', () => {
    render(<Artifacts deliveries={both} canReveal={false} nativeOff={{}} onOpen={noop} onReveal={noop} onCopy={noop} onRevert={noop} />);
    expect(screen.queryByRole('radiogroup', { name: '版本链' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^版本/ }));
    const chain = screen.getByRole('radiogroup', { name: '版本链' });
    const [v1, v2] = within(chain).getAllByRole('radio');
    expect(v1?.textContent).toBe('v1 已驳回');
    expect(v2?.getAttribute('aria-checked')).toBe('true');
    expect(within(screen.getByRole('group', { name: '产物' })).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(v1!);
    expect(within(screen.getByRole('group', { name: '产物' })).getAllByRole('button')).toHaveLength(1);
  });

  it('撤回到 v1 asks first and only then reverts that file of that version; a first version has no 撤回', async () => {
    const onRevert = vi.fn();
    render(<Artifacts deliveries={both} canReveal={false} nativeOff={{}} onOpen={noop} onReveal={noop} onCopy={noop} onRevert={onRevert} />);
    const files = within(screen.getByRole('group', { name: '产物' }));
    fireEvent.contextMenu(files.getByRole('button', { name: /项目分组明细/ }));
    expect(screen.queryByRole('menuitem', { name: /撤回/ })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.contextMenu(files.getByRole('button', { name: /2026-W44 周报/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '撤回到 v1' }));
    const ask = await screen.findByRole('dialog', { name: /恢复至 v1/ });
    expect(onRevert).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: '撤回' }));
    const v2 = pick(DELIVERIES, DLV_T1_V2);
    expect(onRevert).toHaveBeenCalledWith(v2, v2.artifacts.find((a) => a.name === '2026-W44 周报.md'));
  });

  it('reverting POSTs /agent/artifacts/revert {run_id, path, expected_version} and names the new version', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const spy = vi.spyOn(bridge.agentd, 'request').mockResolvedValue({ status: 200, body: { version: 3 } } as never);
    window.agenticComplex = bridge;
    const d = deps(view());
    const v2 = pick(DELIVERIES, DLV_T1_V2);
    const file = v2.artifacts.find((a) => a.name === '2026-W44 周报.md')!;
    await createTasksActions(d).revert(v2, file);
    expect(spy).toHaveBeenCalledWith('POST', '/agent/artifacts/revert', { run_id: v2.run_id, path: file.path, expected_version: 2 });
    expect(d.push).toHaveBeenCalledWith('已恢复版本：2026-W44 周报.md 现为 v3，内容与 v1 一致');
    expect(d.reload).toHaveBeenCalled();
  });
});

describe('the viewed receipt watches the delivery itself', () => {
  /** The nodes the 'viewed' receipt asks IntersectionObserver about. */
  const observed = () => {
    const nodes: Element[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      observe(n: Element) {
        nodes.push(n);
      }
      disconnect() {}
    });
    return nodes;
  };

  it('on the task page, a box with layout that holds the 产物', () => {
    const nodes = observed();
    mount(T1);
    expect(nodes).toHaveLength(1);
    const node = nodes[0] as HTMLElement;
    expect(getComputedStyle(node).display).not.toBe('contents');
    expect(within(node).getByRole('group', { name: '产物' })).toBeTruthy();
  });

  it('in the chat drawer, the 产物 rows, not the whole drawer', () => {
    const nodes = observed();
    render(<TaskDrawer task={pick(TASKS, T1)} effective="waiting" now={NOW} delivery={pick(DELIVERIES, DLV_T1_V2)} onReceipt={vi.fn()} />);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.tagName).not.toBe('ASIDE');
    expect(nodes[0]!.textContent).toContain('产物');
    expect(nodes[0]!.closest('aside')).not.toBeNull();
  });
});

describe('create dialog', () => {
  it('opens as a Dialog with a full title and ⌘↵ submits', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCreated = vi.fn();
    const draft = { ...draftFor('code'), brief: '验证报表差异', cwd: { handle: 'h-1', displayName: 'agent' } };
    render(
      <QueryClientProvider client={client}>
        <CreateDialog draft={draft} setDraft={() => {}} goals={[]} push={() => {}} onCreated={onCreated} />
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('[data-stub="Dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-stub="Modal"]')).toBeNull();
    expect(within(dialog).getByRole('heading').textContent).toBe('新建任务');
    expect(dialog.textContent).not.toContain('NEW');
    fireEvent.keyDown(within(dialog).getByDisplayValue(draft.brief), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('⌘↵ that commits an IME candidate does not submit', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCreated = vi.fn();
    const draft = { ...draftFor('code'), brief: '验证报表差异', cwd: { handle: 'h-1', displayName: 'agent' } };
    render(
      <QueryClientProvider client={client}>
        <CreateDialog draft={draft} setDraft={() => {}} goals={[]} push={() => {}} onCreated={onCreated} />
      </QueryClientProvider>,
    );
    const field = within(screen.getByRole('dialog')).getByDisplayValue(draft.brief);
    const ime = fireEvent.keyDown(field, { key: 'Enter', metaKey: true, isComposing: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(ime).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();
  });
});
