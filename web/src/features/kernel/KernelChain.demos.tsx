import { pick, RUNTIMES } from '../../mock/fixtures';
import type { KernelChainProps } from './KernelChain';

export const KernelChainDemos: Array<{ name: string; props: KernelChainProps }> = [
  { name: 'ready', props: { runtime: pick(RUNTIMES, 'codex') } },
  { name: 'logged-out', props: { runtime: { ...pick(RUNTIMES, 'codex'), authenticated: false }, alternative: pick(RUNTIMES, 'pi'), onRecheck: () => {} } },
  { name: 'missing', props: { runtime: { ...pick(RUNTIMES, 'pi'), available: false, reason: 'runtime_missing' }, surface: 'desk', alternative: pick(RUNTIMES, 'codex') } },
  { name: 'inline', props: { runtime: { ...pick(RUNTIMES, 'codex'), authenticated: false }, surface: 'inline' } },
];
