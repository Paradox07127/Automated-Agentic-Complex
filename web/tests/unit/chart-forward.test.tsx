import type { ComponentType } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CumulativeStep,
  CumulativeStepDemos,
  DivergingBar,
  DivergingBarDemos,
  Donut,
  DonutDemos,
  DotMatrix,
  DotMatrixDemos,
  FlowGraph,
  FlowGraphDemos,
  Gantt,
  GanttDemos,
  LineChart,
  LineChartDemos,
  StackedBars,
  StackedBarsDemos,
  Timeline,
  TimelineDemos,
  Treemap,
  TreemapDemos,
  type ChartCommonProps,
} from '../../src/charts';

afterEach(cleanup);

const STOP = new Date(2026, 9, 29, 14, 31).getTime();

type Case = [string, ComponentType<never>, ChartCommonProps];
const pick = <P extends ChartCommonProps>(name: string, C: ComponentType<P>, demos: Array<{ name: string; props: P }>, demo?: string): Case => {
  const d = demo ? demos.find((x) => x.name === demo) : demos[0];
  if (!d) throw new Error(`no demo ${name} ${demo ?? ''}`);
  return [demo ? `${name} ${demo}` : name, C as ComponentType<never>, d.props];
};

const cases: Case[] = [
  pick('LineChart', LineChart, LineChartDemos),
  pick('Gantt', Gantt, GanttDemos),
  pick('Timeline', Timeline, TimelineDemos),
  pick('CumulativeStep', CumulativeStep, CumulativeStepDemos),
  pick('DivergingBar', DivergingBar, DivergingBarDemos),
  pick('Donut', Donut, DonutDemos),
  pick('DotMatrix', DotMatrix, DotMatrixDemos),
  pick('FlowGraph', FlowGraph, FlowGraphDemos),
  pick('StackedBars', StackedBars, StackedBarsDemos),
  pick('StackedBars', StackedBars, StackedBarsDemos, 'horizontal'),
  pick('Treemap', Treemap, TreemapDemos),
];

describe('every ChartBox chart forwards its stale time and retry', () => {
  it.each(cases)('%s', (_, C, props) => {
    const onRetry = vi.fn();
    const Chart = C as ComponentType<ChartCommonProps>;
    const { container } = render(<Chart {...props} st="error" stoppedAt={STOP} onRetry={onRetry} />);
    const alert = within(container).getByRole('alert');
    expect(alert.textContent).toContain('14:31 的数据');
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
