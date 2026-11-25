import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BracketMeter } from '../../src/charts';
import { usageText } from '../../src/charts/scale';
import { DeliveryBox, VersionChain } from '../../src/features/delivery';
import { JobCells, PlanProgress, RunStepTrack } from '../../src/features/plan';
import { JobCellsDemos } from '../../src/features/plan/JobCells.demos';
import { PlanProgressDemos } from '../../src/features/plan/PlanProgress.demos';
import { RunStepTrackDemos } from '../../src/features/plan/RunStepTrack.demos';
import { RunWaterfall, TaskDetail } from '../../src/features/task';
import { RunWaterfallDemos } from '../../src/features/task/RunWaterfall.demos';
import { TaskDetailDemos } from '../../src/features/task/TaskDetail.demos';
import { DELIVERIES, NOW } from '../../src/mock/fixtures';
import { T1 } from '../../src/mock/fixtures/ids';

afterEach(cleanup);

const demo = <T,>(list: Array<{ name: string; props: T }>, name: string): T => {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`no demo ${name}`);
  return d.props;
};

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('each readout appears once', () => {
  it('RunStepTrack writes its step fraction once', () => {
    const { container } = render(<RunStepTrack {...demo(RunStepTrackDemos, 'plan')} />);
    const p = demo(RunStepTrackDemos, 'plan').run.plan!;
    const frac = `${p.steps.filter((s) => s.status === 'completed').length}/${p.steps.length}`;
    expect(count(container.textContent ?? '', frac)).toBe(1);
  });

  it('PlanProgress writes its step fraction once, live and snapshot', () => {
    const live = demo(PlanProgressDemos, 'live').plan!;
    const a = render(<PlanProgress {...demo(PlanProgressDemos, 'live')} />);
    expect(count(a.container.textContent ?? '', `${live.steps.filter((s) => s.status === 'completed').length}/${live.steps.length}`)).toBe(1);
    cleanup();
    const snap = demo(PlanProgressDemos, 'snapshot').plan!;
    const b = render(<PlanProgress {...demo(PlanProgressDemos, 'snapshot')} />);
    expect(count(b.container.textContent ?? '', `—/${snap.steps.length}`)).toBe(1);
  });

  it('JobCells writes its done fraction once', () => {
    const jobs = demo(JobCellsDemos, 'active').jobs;
    const { container } = render(<JobCells jobs={jobs} />);
    expect(count(container.textContent ?? '', `${jobs.filter((j) => j.effective === 'done').length}/${jobs.length}`)).toBe(1);
  });

  it('RunWaterfall has one table switch', () => {
    render(<RunWaterfall {...demo(RunWaterfallDemos, 'two-runs')} />);
    expect(screen.getAllByText('以表格查看')).toHaveLength(1);
  });

});

describe('90–100 % reads 接近上限, above 100 % reads 超限', () => {
  it('scale text per band', () => {
    expect(usageText(60, 100)).toBe('正常');
    expect(usageText(80, 100)).toBe('偏高');
    expect(usageText(90, 100)).toBe('接近上限');
    expect(usageText(100, 100)).toBe('接近上限');
    expect(usageText(101, 100)).toBe('超限');
  });

  it('BracketMeter keeps danger ■ but says 接近上限 inside the budget', () => {
    const { container } = render(<BracketMeter value={15.6} max={16.7} label="P95" size="lg" />);
    const el = container.querySelector('[data-stub="BracketMeter"]');
    expect(el?.getAttribute('data-level')).toBe('over');
    expect(el?.querySelector('[data-shape]')?.getAttribute('data-shape')).toBe('square');
    expect(el?.getAttribute('aria-label')).toBe('P95 15.6/16.7，接近上限');
    expect(el?.textContent).toContain('接近上限');
    expect(el?.textContent).not.toContain('超限');
  });
});

describe('version chain buttons switch the shown delivery', () => {
  it('clicking v1 shows v1 in the delivery box', () => {
    const { container } = render(<DeliveryBox deliveries={DELIVERIES.filter((d) => d.task_id === T1)} now={NOW} />);
    const box = container.querySelector('[data-stub="DeliveryBox"]') as HTMLElement;
    expect(box.getAttribute('aria-label')).toBe('交付 v2');
    const v1 = within(box).getByRole('button', { name: /^v1/ });
    fireEvent.click(v1);
    expect(box.getAttribute('aria-label')).toBe('交付 v1');
    expect(box.textContent).toContain('交付 v1');
    expect(v1.getAttribute('aria-pressed')).toBe('true');
  });

  it('without onPick the chain has no dead buttons', () => {
    const { container } = render(<VersionChain deliveries={DELIVERIES.filter((d) => d.task_id === T1)} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
  });
});

describe('no yellow gradient next to another primary action', () => {
  it('TaskDetail under review marks the delivery box quiet', () => {
    const props = demo(TaskDetailDemos, 'review');
    const { container } = render(<TaskDetail {...props} />);
    expect(screen.getByText('接受这一版')).toBeTruthy();
    expect(container.querySelector('[data-stub="DeliveryBox"]')?.hasAttribute('data-quiet')).toBe(true);
  });

  it('a lone delivery box under review keeps the gradient', () => {
    const { container } = render(<DeliveryBox deliveries={DELIVERIES.filter((d) => d.task_id === T1)} now={NOW} />);
    const box = container.querySelector('[data-stub="DeliveryBox"]');
    expect(box?.hasAttribute('data-review')).toBe(true);
    expect(box?.hasAttribute('data-quiet')).toBe(false);
  });
});
