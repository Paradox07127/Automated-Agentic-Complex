import { HEALTH, healthOf, NOW } from '../../mock/fixtures';
import type { HealthChainProps } from './HealthChain';

export const HealthChainDemos: Array<{ name: string; props: HealthChainProps }> = [
  { name: 'ok', props: { health: HEALTH, now: NOW } },
  { name: 'kernel-bad', props: { health: healthOf({ kernelBad: true }), now: NOW, layout: 'wide' } },
  { name: 'backoff', props: { health: healthOf({ backoff: 8 }), now: NOW, layout: 'desk' } },
  { name: 'agentd-down', props: { health: healthOf({ agentdDown: true }), now: NOW, layout: 'wide' } },
];
