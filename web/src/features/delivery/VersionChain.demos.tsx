import { DELIVERIES } from '../../mock/fixtures';
import { T1, T4 } from '../../mock/fixtures/ids';
import type { VersionChainProps } from './VersionChain';

export const VersionChainDemos: Array<{ name: string; props: VersionChainProps }> = [
  { name: 'rejected-then-waiting', props: { deliveries: DELIVERIES.filter((d) => d.task_id === T1) } },
  { name: 'accepted', props: { deliveries: DELIVERIES.filter((d) => d.task_id === T4) } },
];
