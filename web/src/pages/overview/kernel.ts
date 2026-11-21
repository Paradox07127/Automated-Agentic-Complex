import { composeHealth, fromRuntimePublic, type Health, type WireRuntimePublic } from '../../domain';
import type { OverviewSnapshot } from './load';

export interface OverviewRuntime {
  kernel: OverviewSnapshot['kernel'];
  runtime: Health['runtime'];
}

function kernelOf(w: WireRuntimePublic): OverviewSnapshot['kernel'] {
  const k = fromRuntimePublic(w);
  const runtime = k.runtimes.find((r) => r.id === k.selected);
  if (!runtime) return null;
  const alternative = runtime.authenticated === false ? (k.runtimes.find((r) => r.id !== runtime.id && r.authenticated) ?? null) : null;
  return { runtime, alternative };
}

/** Maps the shared `/character/runtime` read (data/runtime.ts) to the overview's kernel and health halves. */
export const runtimeOf = (w: WireRuntimePublic): OverviewRuntime => ({ kernel: kernelOf(w), runtime: composeHealth('connected', w, null, null).runtime });

/** Health shows only when both the diag read and the kernel read answered. */
export function withRuntime(s: OverviewSnapshot, r: OverviewRuntime | undefined): OverviewSnapshot {
  return { ...s, health: s.health && r ? { ...s.health, runtime: r.runtime } : null, kernel: r?.kernel ?? null };
}
