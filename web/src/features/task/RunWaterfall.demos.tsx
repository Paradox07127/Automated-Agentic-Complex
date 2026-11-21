import { DELIVERIES, NOW, STEP_EVENTS, TOOL_ITEMS } from '../../mock/fixtures';
import { T1, T6, T8 } from '../../mock/fixtures/ids';
import type { RunWaterfallProps } from './RunWaterfall';

const demo = (id: string): RunWaterfallProps => ({ steps: STEP_EVENTS[id] ?? [], tools: TOOL_ITEMS[id] ?? [], deliveries: DELIVERIES.filter((d) => d.task_id === id), now: NOW });

export const RunWaterfallDemos: Array<{ name: string; props: RunWaterfallProps }> = [
  { name: 'two-runs', props: demo(T1) },
  { name: 'failed', props: demo(T6) },
  { name: 'queued', props: { ...demo(T8), queued: true } },
  { name: 'error', props: { ...demo(T1), status: 'error', failedPath: `/agent/tasks/${T1}/steps` } },
];
