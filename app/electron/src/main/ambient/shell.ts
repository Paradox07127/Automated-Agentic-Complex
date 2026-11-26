// The ambient sampler as index.ts starts it: its ports over the attention sampler's last
// sample, the blacklist file and config.json. A screen sample reads the user's screen, so `--no-attention` starts none.
import { join } from 'node:path';
import type { AttentionSample, Rect } from '../../common/attention.ts';
import { helperYFor } from '../attention/watchers.ts';
import { BlacklistFile } from '../attention/blacklist.ts';
import { type AmbientPorts, AmbientSampler } from './sampler.ts';

/** HostLink options: `ambient` goes in the hello only when the sampler runs. */
export function ambientOffers(argv: readonly string[]): 'ambient'[] {
  return argv.includes('--no-attention') ? [] : ['ambient'];
}

export interface ShellAmbientOptions {
  argv: readonly string[];
  platform: 'mac' | 'windows';
  helper: AmbientPorts['helper'];
  link: AmbientPorts['link'];
  /** Shared blacklist file; created if omitted. */
  blacklist?: BlacklistFile;
  /** `agentd_state_dir`, which holds blacklist.json. */
  agentdStateDir: string;
  settings(): Record<string, unknown>;
  /** The attention sampler; null without one. */
  attention(): { readonly lastSample: AttentionSample | null } | null;
  ownPids(): readonly number[];
  excludePids(): readonly number[];
  /** In C3 global points. */
  visual(): Rect | null;
  figure(): Rect | null;
  log(line: string): void;
  /** Tests drive the timers; monotonic milliseconds. */
  clock?: { now(): number; every(ms: number, fn: () => void): () => void };
}

/** Idle until `start` (her renderer runs); null with `--no-attention`. */
export function shellAmbient(o: ShellAmbientOptions): AmbientSampler | null {
  if (o.argv.includes('--no-attention')) return null;
  const blacklist = o.blacklist ?? new BlacklistFile(join(o.agentdStateDir, 'blacklist.json'));
  const clock = o.clock ?? {
    now: () => performance.now(),
    every: (ms: number, fn: () => void) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  };
  return new AmbientSampler({
    helper: o.helper, link: o.link, settings: o.settings,
    front: () => {
      const s = o.attention()?.lastSample;
      return s?.front ? { window: s.front, incognito: s.frontIncognito, secureInput: s.secureInput } : null;
    },
    blacklist: () => blacklist.rules(), ownPids: o.ownPids, excludePids: o.excludePids, visual: o.visual, figure: o.figure,
    helperY: helperYFor(o.platform), now: clock.now, every: clock.every, log: o.log,
  });
}
