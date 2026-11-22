// The attention sampler as index.ts starts it: its ports over agentd's client, the blacklist file and config.json.
import { join } from 'node:path';
import type { AttentionSample, HelperY } from '../../common/attention.ts';
import type { Subsystem } from '../../common/plugins.ts';
import { agentdPost } from '../context/shell.ts';
import { BlacklistFile } from './blacklist.ts';
import { type AttentionPorts, type AttentionSampler, startAttention } from './sampler.ts';

export interface ShellAttentionOptions {
  /** The shell's arguments: `--no-attention` (test and host runs) starts no sampler, so no window title is read. */
  argv: readonly string[];
  helper: AttentionPorts['helper'];
  agentd: { request(method: string, path: string, json?: unknown): Promise<{ status: number; body: Buffer }> };
  /** `agentd_state_dir`, which holds blacklist.json. */
  agentdStateDir: string;
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** shellPlan of the plug-ins agentd runs with: without `attention` the samples feed only this shell (give-way, surfaces)
   *  and agentd's `/user/coarse`. */
  plan(): ReadonlySet<Subsystem>;
  ownPids(): readonly number[];
  userSpeaking(): boolean | null;
  log(line: string): void;
  onSystemPaused(paused: boolean): void;
  /** After each beat's sample. */
  onSample?(sample: AttentionSample): void;
  /** The reflex rect's C3 y on this platform. */
  helperY?: HelperY;
  /** A screen capture of this shell's own is running or just ended. */
  ownCaptureRecent?(): boolean;
  /** Null leaves `near_clicks_10s` out. */
  nearClicks?(): number | null;
}

/** The sampler, idle until the helper says hello and agentd runs; null with `--no-attention`. */
export function shellAttention(o: ShellAttentionOptions): AttentionSampler | null {
  if (o.argv.includes('--no-attention')) return null;
  const blacklist = new BlacklistFile(join(o.agentdStateDir, 'blacklist.json'));
  const post = agentdPost(o.agentd);
  return startAttention({
    helper: o.helper,
    post: async (body) => (await post('/context/attention', body)).status,
    postCoarse: (body) => post('/user/coarse', body),
    aware: () => o.plan().has('attention'),
    blacklist: () => blacklist.rules(),
    // Anything but a saved `false` is on.
    sensing: () => {
      const s = o.settings();
      return { input: s.sense_input_counts !== false, audioApps: s.sense_audio_apps !== false, redact: s.redact_sensitive !== false };
    },
    ownPids: o.ownPids,
    userSpeaking: o.userSpeaking,
    now: Date.now,
    every: (ms, fn) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    log: o.log,
    onSystemPaused: o.onSystemPaused,
    ...(o.onSample && { onSample: o.onSample }),
    ...(o.helperY && { helperY: o.helperY }),
    ...(o.ownCaptureRecent && { ownCaptureRecent: o.ownCaptureRecent }),
    ...(o.nearClicks && { nearClicks: o.nearClicks }),
  });
}
