// Shared features: a stopped task offers only what agentd can do, the session link says why it is off,
// the swimlane counts by lane.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Swimlane, SwimlaneDemos, type SwimlaneLane } from '../../src/charts';
import type { Task } from '../../src/domain';
import { ApprovalCard } from '../../src/features/approval';
import { resumeOf, StopConfirm, TaskDrawer } from '../../src/features/task';
import { APPROVALS, NOW, pick, TASKS } from '../../src/mock/fixtures';
import { A2, S_C07A, T1, T2 } from '../../src/mock/fixtures/ids';
import { BottomBar } from '../../src/pages/tasks/Bottom';
import { deriveView, emptyLocal } from '../../src/pages/tasks/model';
import type { TaskDesk } from '../../src/pages/tasks/useTaskDesk';

afterEach(cleanup);

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => list.find((x) => x.name === name)!.props;
const legendOf = (c: HTMLElement) => [...c.querySelectorAll('[data-chart-legend] li')].map((li) => li.textContent);
const descOf = (c: HTMLElement) => c.querySelector('[data-chart-desc]')?.textContent ?? '';

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
    expect(note()).toContain('之后可以在任务里「继续」');
    expect(note()).not.toContain('重新交派');
    ui.unmount();
    render(<StopConfirm open target={t1.title} resume="none" />);
    expect(note()).toContain('不能恢复执行');
    expect(note()).not.toContain('重新交派');
  });

  it('a mixed selection says both', () => {
    render(<StopConfirm open target={2} resume="some" />);
    expect(note()).toContain('角色台账任务之后可以「继续」，其他任务不能恢复执行');
  });
});

describe('ApprovalCard: why the session link is off', () => {
  const link = () => screen.getByRole('button', { name: '会话 ↗' });

  it('shows the reason it is given', () => {
    render(<ApprovalCard approval={pick(APPROVALS, A2)} sessionReason="这台电脑的外壳暂不支持跳到终端" />);
    expect(link().getAttribute('aria-disabled')).toBe('true');
    expect(link().getAttribute('title')).toBe('这台电脑的外壳暂不支持跳到终端');
  });

  it('the task page passes its own reason to 跳到终端 in its bottom bar', () => {
    const noop = () => {};
    const own = { id: S_C07A, task_id: T2, kind: 'code' as const, own: true, target: 'codex' as const, display_session: null, agent: 'Codex', title: 'companion', state: 'running' as const, since: NOW, cwd: '~/Endfield/app' };
    const view = deriveView({ tasks: TASKS, deliveries: [], sessions: [own], approvals: [], questions: [], goals: [], activeRuns: {}, roleMissing: false }, emptyLocal());
    const desk = { view, actions: { onTask: () => noop }, local: emptyLocal(), nativeOff: { jump: '这台电脑的外壳暂不支持跳到终端' } } as unknown as TaskDesk;
    render(
      <BottomBar tab="run" empty={false} newLabel="派发任务" onNew={noop} draft={null} problem={null} busy={false} onCancel={noop} onSubmit={noop} task={pick(view.tasks, T2)} desk={desk} dev={false} schedule={null} onNote={noop} onAgain={noop} onGoChat={noop} onEdit={noop} onRunNow={noop} runOff={null} runBusy={false} onDelete={noop} />,
    );
    const jump = screen.getByRole('button', { name: '跳到终端' });
    expect(jump.getAttribute('aria-disabled')).toBe('true');
    expect(jump.getAttribute('title')).toBe('这台电脑的外壳暂不支持跳到终端');
  });
});

describe('Swimlane counts by lane', () => {
  it('the legend counts each lane by category; a one-state lane is the lane itself', () => {
    const { container } = render(<Swimlane {...demo(SwimlaneDemos, 'day')} />);
    expect(legendOf(container)).toEqual(['运行 │ 进行中 1', '运行 │ 失败 1', '运行 │ 已完成 1', '编码 │ 失败 1', '编码 │ 已完成 1', '审批 2', '▼门禁失败 1']);
    expect(descOf(container)).toMatch(/^运行 3 段，编码 2 段，审批 2 段，最长/);
  });

  it('memory 在电脑前: present bars count as the lane, away bars by their label, not as 已完成 / 空闲', () => {
    const t = (h: number) => new Date(2026, 9, 29, h).getTime();
    const lanes: SwimlaneLane[] = [
      { id: 'ep', label: '活动', kind: 'done', bars: [{ id: 'e1', start: t(9), end: t(10), state: 'done', label: '写代码' }, { id: 'e2', start: t(10), end: t(11), state: 'done', label: '开会' }] },
      {
        id: 'here',
        label: '在电脑前',
        kind: 's1',
        narrow: true,
        bars: [{ id: 'p1', start: t(9), end: t(10), state: 'done' }, { id: 'p2', start: t(10), end: t(11), state: 'idle', label: '离开', hatched: true }],
      },
    ];
    const { container } = render(<Swimlane label="活动时间轴" lanes={lanes} start={t(8)} end={t(12)} />);
    expect(legendOf(container)).toEqual(['活动 2', '在电脑前 1', '离开 1']);
    expect(descOf(container)).toMatch(/^活动 2 段，在电脑前 2 段/);
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('活动时间轴，活动 2 段，在电脑前 2 段');
  });
});
