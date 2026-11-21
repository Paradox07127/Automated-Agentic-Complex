import { TURNS } from '../../mock/fixtures';
import type { TraceLineProps } from './TraceLine';
import type { TraceGroupProps } from './TraceGroup';

const turn = TURNS[1];
const stages: TraceLineProps[] = (turn?.stages ?? []).map((s) => ({ title: s.name, state: 'completed', durationMs: s.duration_ms }));

export const TraceGroupDemos: Array<{ name: string; props: TraceGroupProps }> = [
  { name: 'default', props: { icon: 'hub', title: turn?.source ?? '对话', state: 'completed', durationMs: turn?.duration_ms ?? null, items: stages } },
  { name: 'open', props: { icon: 'hub', title: turn?.source ?? '对话', state: 'completed', durationMs: turn?.duration_ms ?? null, items: stages, defaultOpen: true } },
];
