import { DELIVERIES, NOW, pick } from '../../mock/fixtures';
import { DLV_T1_V1, DLV_T1_V2, DLV_T4_V1 } from '../../mock/fixtures/ids';
import type { DeliveryChainProps } from './DeliveryChain';

export const DeliveryChainDemos: Array<{ name: string; props: DeliveryChainProps }> = [
  { name: 'waiting', props: { delivery: pick(DELIVERIES, DLV_T1_V2), now: NOW } },
  { name: 'accepted', props: { delivery: pick(DELIVERIES, DLV_T4_V1), now: NOW, size: 'compact' } },
  { name: 'rejected', props: { delivery: pick(DELIVERIES, DLV_T1_V1), now: NOW, size: 'compact' } },
];
