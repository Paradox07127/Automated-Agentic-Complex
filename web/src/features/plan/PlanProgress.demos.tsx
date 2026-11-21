import { activeRunOf } from '../../mock/fixtures';
import { T1, T3 } from '../../mock/fixtures/ids';
import type { PlanProgressProps } from './PlanProgress';

export const PlanProgressDemos: Array<{ name: string; props: PlanProgressProps }> = [
  { name: 'live', props: { plan: activeRunOf(T3).plan, onOpen: () => {} } },
  { name: 'none', props: { plan: null } },
  { name: 'snapshot', props: { plan: activeRunOf(T1).plan, source: 'snapshot', size: 'card' } },
  { name: 'row', props: { plan: activeRunOf(T1).plan, size: 'row' } },
];
