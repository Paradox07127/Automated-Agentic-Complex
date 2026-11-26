// The computer control host as index.ts starts it: its ports over the helper, config.json and the blacklist file.
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { controlEndpoint } from '../../common/agentd.ts';
import type { ComputerUsePanelState } from '../../common/computer-control.ts';
import type { Plugins } from '../../common/plugins.ts';
import { BlacklistFile } from '../attention/blacklist.ts';
import { shellPlatform } from '../platform/index.ts';
import { ControlHost, type ControlPorts } from './host.ts';

export interface ShellControlOptions {
  /** The shell's arguments: `--no-attention` (test and host runs) starts no control, so no window is read or acted on. */
  argv: readonly string[];
  helper: ControlPorts['helper'];
  /** Shared blacklist file; created if omitted. */
  blacklist?: BlacklistFile;
  supportDir: string;
  configPath: string;
  /** `agentd_state_dir`, which holds blacklist.json. */
  agentdStateDir: string;
  /** config.json at `path` as validated now (loadConfig); throws while it does not load. */
  saved(path: string): { plugins: Plugins };
  /** This shell's processes, never a target. */
  ownPids(): readonly number[];
  log(line: string): void;
  /** Each published panel state, for the stack card, `desktop.onState` and the panel (`raise`,
   *  `ControlPanel.present`). */
  onState?(state: ComputerUsePanelState, raise: boolean): void;
}

/** The `computer_use` plug-in: config.json is loaded again only when its mtime, size or inode changes; false
 *  while it is missing or does not load. */
export function savedComputerUse(path: string, saved: ShellControlOptions['saved']): () => boolean {
  let stamp: string | null = null, enabled = false;
  return () => {
    let now: string;
    try {
      const st = statSync(path, { bigint: true });
      now = `${st.mtimeNs}:${st.size}:${st.ino}`;
    } catch {
      stamp = null;
      enabled = false;
      return enabled;
    }
    if (now !== stamp) {
      try {
        enabled = saved(path).plugins.computer_use;
      } catch {
        enabled = false;
      }
      stamp = now;
    }
    return enabled;
  };
}

/** Idle until the helper's first hello, which asks for the endpoint; null with `--no-attention`. */
export function shellControl(o: ShellControlOptions): ControlHost | null {
  if (o.argv.includes('--no-attention')) return null;
  const blacklist = o.blacklist ?? new BlacklistFile(join(o.agentdStateDir, 'blacklist.json'));
  const host = new ControlHost({
    helper: o.helper, endpoint: controlEndpoint(o.supportDir, shellPlatform()), enabled: savedComputerUse(o.configPath, o.saved),
    blacklist: () => blacklist.rules(), ownPids: o.ownPids, now: Date.now,
    after: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    newId: () => randomUUID(), log: o.log,
  });
  if (o.onState) host.onPanel = o.onState;
  return host;
}
