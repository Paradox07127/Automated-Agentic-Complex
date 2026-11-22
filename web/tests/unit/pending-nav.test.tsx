import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sortPending } from '../../src/domain';
import { RunStepTrack } from '../../src/features/plan';
import { RunStepTrackDemos } from '../../src/features/plan/RunStepTrack.demos';
import { RunWaterfall, TaskDrawer } from '../../src/features/task';
import { RunWaterfallDemos } from '../../src/features/task/RunWaterfall.demos';
import { TaskDrawerDemos } from '../../src/features/task/TaskDrawer.demos';
import { ACTIVE_RUNS, activeRunOf, NOW, pick, SESSIONS, TASKS } from '../../src/mock/fixtures';
import { RunningSection } from '../../src/pages/overview/RunningSection';
import { T1 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};

describe('sortPending: approvals with ≤ 10 s left become the focus card', () => {
  it('an urgent approval goes ahead of a dangerous one with time left', () => {
    const items = [
      { id: 'a-danger', kind: 'approval' as const, dangerous: true, seconds_left: 40, since: 100 },
      { id: 'a-8', kind: 'approval' as const, seconds_left: 8, since: 200 },
    ];
    expect(sortPending(items).map((x) => x.id)).toEqual(['a-8', 'a-danger']);
  });

  it('urgent and dangerous comes before urgent only, even with more time left', () => {
    const items = [
      { id: 'a-3', kind: 'approval' as const, seconds_left: 3, since: 100 },
      { id: 'a-danger-9', kind: 'approval' as const, dangerous: true, seconds_left: 9, since: 200 },
      { id: 'a-danger-40', kind: 'approval' as const, dangerous: true, seconds_left: 40, since: 300 },
    ];
    expect(sortPending(items).map((x) => x.id)).toEqual(['a-danger-9', 'a-3', 'a-danger-40']);
  });

  it('neither urgent nor dangerous: less time left, then kind, then waited longer', () => {
    const items = [
      { id: 'review', kind: 'review' as const, since: 50 },
      { id: 'q-new', kind: 'question' as const, since: 300 },
      { id: 'a-30', kind: 'approval' as const, seconds_left: 30, since: 400 },
      { id: 'q-old', kind: 'question' as const, since: 200 },
      { id: 'a-20', kind: 'approval' as const, seconds_left: 20, since: 500 },
    ];
    expect(sortPending(items).map((x) => x.id)).toEqual(['a-20', 'a-30', 'q-old', 'q-new', 'review']);
  });

  it('only approvals that can still be decided are promoted', () => {
    const items = [
      { id: 'a-danger', kind: 'approval' as const, dangerous: true, seconds_left: 40, since: 100 },
      { id: 'q-5', kind: 'question' as const, seconds_left: 5, since: 200 },
      { id: 'a-expired', kind: 'approval' as const, seconds_left: 0, since: 300 },
    ];
    expect(sortPending(items).map((x) => x.id)).toEqual(['a-danger', 'a-expired', 'q-5']);
  });
});

describe('overview running row of a task waiting for review carries 「◆ 待处理」', () => {
  it('needs_review row shows the tag and says so in aria', () => {
    render(<RunStepTrack task={pick(TASKS, T1)} run={activeRunOf(T1)} effective="waiting" now={NOW} />);
    const row = screen.getByRole('button', { name: /整理本周提交周报/ });
    expect(within(row).getByText('◆ 待处理')).toBeTruthy();
    expect(row.getAttribute('aria-label')).toContain('待复核');
  });

  it('running rows and rows already showing 待审批 have no extra tag', () => {
    render(<RunStepTrack {...demo(RunStepTrackDemos, 'plan')} />);
    render(<RunStepTrack {...demo(RunStepTrackDemos, 'waiting')} />);
    expect(screen.queryByText('◆ 待处理')).toBeNull();
  });
});

describe('the overview run row lands on the run waterfall', () => {
  it('the waterfall is the landing target in every state', () => {
    for (const name of ['two-runs', 'queued', 'error']) {
      const { container, unmount } = render(<RunWaterfall {...demo(RunWaterfallDemos, name)} />);
      expect(container.querySelector('[data-stub="RunWaterfall"]')?.getAttribute('data-nav-target'), name).toBe('run-waterfall');
      unmount();
    }
  });

  it('a role task row and a coding session row with a task open that task on the tasks page', () => {
    const go = vi.fn();
    const own = SESSIONS.find((x) => x.own && x.task_id)!;
    render(
      <RunningSection
        q={{ status: 'success', data: true }}
        rows={[{ k: 'task', id: T1, task: pick(TASKS, T1) }, { k: 'code', id: own.id, session: own, started: null }]}
        convs={0}
        code={1}
        activeRuns={ACTIVE_RUNS}
        now={NOW}
        lost={false}
        go={go}
        onJumpSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^角色任务「${pick(TASKS, T1).title}」`) }));
    expect(go).toHaveBeenLastCalledWith({ page: 'tasks', sel: T1 });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${own.title}，`) }));
    expect(go).toHaveBeenLastCalledWith({ page: 'tasks', sel: own.task_id });
  });
});

describe('the task drawer version chain switches versions', () => {
  it('picking v1 shows v1 and marks it pressed', () => {
    const { container } = render(<TaskDrawer {...demo(TaskDrawerDemos, 'review')} />);
    const chain = container.querySelector('[data-stub="VersionChain"]') as HTMLElement;
    const v1 = within(chain).getByRole('button', { name: /^v1/ });
    const v2 = within(chain).getByRole('button', { name: /^v2/ });
    expect(v2.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('接受这一版')).toBeTruthy();
    fireEvent.click(v1);
    expect(v1.getAttribute('aria-pressed')).toBe('true');
    expect(v2.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('接受这一版')).toBeNull();
    expect(screen.getByText(/这一版已退回/)).toBeTruthy();
  });
});
