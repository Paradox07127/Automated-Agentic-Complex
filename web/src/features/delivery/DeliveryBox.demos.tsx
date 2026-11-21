import { DELIVERIES, NOW } from '../../mock/fixtures';
import { T1, T4 } from '../../mock/fixtures/ids';
import type { DeliveryBoxProps } from './DeliveryBox';

export const DeliveryBoxDemos: Array<{ name: string; props: DeliveryBoxProps }> = [
  { name: 'review', props: { deliveries: DELIVERIES.filter((d) => d.task_id === T1), now: NOW, canReveal: true } },
  { name: 'accepted', props: { deliveries: DELIVERIES.filter((d) => d.task_id === T4), now: NOW } },
];
