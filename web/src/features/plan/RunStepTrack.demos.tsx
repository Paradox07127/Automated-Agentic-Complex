import { activeRunOf, NOW, pick, TASKS } from '../../mock/fixtures';
import { T1, T2, T3 } from '../../mock/fixtures/ids';
import type { RunStepTrackProps } from './RunStepTrack';

export const RunStepTrackDemos: Array<{ name: string; props: RunStepTrackProps }> = [
  { name: 'plan', props: { task: pick(TASKS, T3), run: activeRunOf(T3), effective: 'running', now: NOW } },
  { name: 'waiting', props: { task: pick(TASKS, T2), run: { ...activeRunOf(T3), run_id: 'run-c07a', state: 'awaiting_approval', phase: 'awaiting', tool: undefined, tools: 7, plan: null }, effective: 'waiting', now: NOW } },
  { name: 'review', props: { task: pick(TASKS, T1), run: activeRunOf(T1), effective: 'waiting', now: NOW } },
  { name: 'lost', props: { task: pick(TASKS, T3), run: activeRunOf(T3), effective: 'running', now: NOW, lost: true } },
];
