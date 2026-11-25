// Shared features: a stopped task offers only what agentd can do, the session link says why it is off.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/domain';
import { ApprovalCard } from '../../src/features/approval';
import { resumeOf, StopConfirm, TaskDrawer } from '../../src/features/task';
import { APPROVALS, NOW, pick, TASKS } from '../../src/mock/fixtures';
import { A2, S_C07A, T1, T2 } from '../../src/mock/fixtures/ids';
import { BottomBar } from '../../src/pages/tasks/Bottom';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import type { TaskDesk } from '../../src/pages/tasks/useTaskDesk';

afterEach(cleanup);

describe('TaskDrawer: a stopped task', () => {
  const t1 = pick(TASKS, T1);

  it('a cancelled job cannot resume (jobs.py resume), so no button but the stop line', () => {
    const job: Task = { ...t1, status: 'cancelled' };
    render(<TaskDrawer task={job} effective="stopped" now={NOW} />);
    expect(screen.getByRole('status').textContent).toContain('已停止');
    expect(screen.queryByText('重新交派')).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
  });

  it('a cancelled character ledger task continues from its checkpoint (/tasks/{id}/continue)', () => {
    const onAction = vi.fn();
    const ledger: Task = { ...t1, id: 'task:character-run-77a2', job_id: null, task_id: 'character-run-77a2', target: 'character', status: 'cancelled' };
    render(<TaskDrawer task={ledger} effective="stopped" now={NOW} onAction={onAction} />);
    expect(screen.queryByText('重新交派')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '接着汇总' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'continue', note: '接着汇总', useCurrentKernel: true });
  });
});

describe('StopConfirm: what happens after a stop, by task kind', () => {
  const t1 = pick(TASKS, T1);
  const ledger: Task = { ...t1, id: 'task:character-run-77a2', job_id: null, task_id: 'character-run-77a2', target: 'character' };
  const note = () => screen.getByRole('dialog').textContent ?? '';

  it('a character ledger task can 继续 later; a job cannot resume', () => {
    expect(resumeOf([ledger])).toBe('all');
    expect(resumeOf([t1])).toBe('none');
    expect(resumeOf([t1, ledger])).toBe('some');
    const ui = render(<StopConfirm open target={ledger.title} resume="all" />);
    expect(note()).toContain('后续可在任务详情中「继续」');
    expect(note()).not.toContain('重新交派');
    ui.unmount();
    render(<StopConfirm open target={t1.title} resume="none" />);
    expect(note()).toContain('无法恢复执行');
    expect(note()).not.toContain('重新交派');
  });

  it('a mixed selection says both', () => {
    render(<StopConfirm open target={2} resume="some" />);
    expect(note()).toContain('角色任务后续可「继续」，其余任务停止后无法恢复执行');
  });
});

describe('ApprovalCard: why the session link is off', () => {
  const link = () => screen.getByRole('button', { name: '会话 ↗' });

  it('shows the reason it is given', () => {
    render(<ApprovalCard approval={pick(APPROVALS, A2)} sessionReason="当前客户端环境暂不支持跳转至终端" />);
    expect(link().getAttribute('aria-disabled')).toBe('true');
    expect(link().getAttribute('title')).toBe('当前客户端环境暂不支持跳转至终端');
  });

  it('the task page passes its own reason to 跳到终端 in its bottom bar', () => {
    const noop = () => {};
    const own = { id: S_C07A, task_id: T2, kind: 'code' as const, own: true, target: 'codex' as const, display_session: null, agent: 'Codex', title: 'companion', state: 'running' as const, since: NOW, cwd: '~/Endfield/app' };
    const view = deriveView({ tasks: TASKS, deliveries: [], sessions: [own], approvals: [], questions: [], goals: [], activeRuns: {}, roleMissing: false }, emptyLocal());
    const desk = { view, actions: { onTask: () => noop }, local: emptyLocal(), nativeOff: { jump: '当前客户端环境暂不支持跳转至终端' } } as unknown as TaskDesk;
    render(
      <BottomBar tab="run" empty={false} newLabel="派发任务" onNew={noop} draft={null} problem={null} busy={false} onCancel={noop} onSubmit={noop} task={pick(view.tasks, T2)} desk={desk} dev={false} schedule={null} onNote={noop} onAgain={noop} onGoChat={noop} onEdit={noop} onRunNow={noop} runOff={null} runBusy={false} onDelete={noop} />,
    );
    const jump = screen.getByRole('button', { name: '跳转终端' });
    expect(jump.getAttribute('aria-disabled')).toBe('true');
    expect(jump.getAttribute('title')).toBe('当前客户端环境暂不支持跳转至终端');
  });
});
