import { at, NOW } from '../../mock/fixtures';
import type { WaitMeterProps } from './WaitMeter';

export const WaitMeterDemos: Array<{ name: string; props: WaitMeterProps }> = [
  { name: 'short', props: { since: at(14, 27, 40), now: NOW } },
  { name: 'medium', props: { since: at(14, 12), now: NOW, onPaper: true } },
  { name: 'long', props: { since: at(13, 40), now: NOW } },
];
