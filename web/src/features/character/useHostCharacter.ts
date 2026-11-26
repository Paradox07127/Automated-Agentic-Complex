import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge, type CharacterEntry, type MmdSyncState } from '../../bridge';
import type { RuntimeProcess, RuntimeSnapshot } from '../../bridge/runtimeSnapshot';

export interface HostCharacter {
  /** The character the shell and agentd agree on; null until known. */
  current: string | null;
  switching: boolean;
  /** The avatar process as the runtime last reported it; null until known. */
  avatar: RuntimeProcess | null;
}

/** The runtime's avatar process states in which she is not running. */
export const RUNTIME_DOWN: ReadonlySet<string> = new Set(['stopped', 'backoff', 'port_in_use', 'failed']);

const UNKNOWN: HostCharacter = { current: null, switching: false, avatar: null };
/** What a switch changes: the roster's active one and her appearances, her actions, state and imported motions. */
const PER_CHARACTER = [['character', 'list'], ['character', 'motions'], ['character', 'state'], ['character', 'importedMotions']];

/** The host's current character and avatar process from `app.runtime` and its pushes; a change of character reads her data again. `confirm` takes a switch the page saw succeed. */
export function useHostCharacter(canAvatar: boolean): HostCharacter & { confirm: (id: string) => void } {
  const qc = useQueryClient();
  const [host, setHost] = useState<HostCharacter>(UNKNOWN);
  // Set by a push or a confirmed switch: the first read may be older.
  const fresh = useRef(false);
  useEffect(() => {
    if (!canAvatar) return;
    let live = true;
    const apply = (s: RuntimeSnapshot) => live && setHost({ current: s.character.current, switching: s.character.switching, avatar: s.processes.avatar });
    getBridge()
      .app.runtime()
      .then((s) => !fresh.current && apply(s), () => {});
    const off = getBridge().app.onRuntime((s) => {
      fresh.current = true;
      apply(s);
    });
    return () => {
      live = false;
      off();
    };
  }, [canAvatar]);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (host.current == null) return;
    if (seen.current != null && seen.current !== host.current) for (const queryKey of PER_CHARACTER) void qc.invalidateQueries({ queryKey });
    seen.current = host.current;
  }, [host.current, qc]);
  const confirm = (id: string) => {
    fresh.current = true;
    setHost((h) => ({ ...h, current: id }));
  };
  return { ...host, confirm };
}

/** The roster entry of `host`, else the one the roster calls active, else its first. */
export const currentOf = (roster: CharacterEntry[] | undefined, host: string | null) => roster?.find((c) => c.id === host) ?? roster?.find((c) => c.active) ?? roster?.[0];

const SYNC_IDLE: MmdSyncState = { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 };

/** Native bakes the MMD library into her after a switch; when that ends her actions and the library's states may have changed. */
export function useMmdSync(canAvatar: boolean): MmdSyncState {
  const qc = useQueryClient();
  const [sync, setSync] = useState<MmdSyncState>(SYNC_IDLE);
  useEffect(() => {
    if (!canAvatar) return;
    let running = false;
    let pushed = false;
    const apply = (s: MmdSyncState) => {
      if (running && !s.running) {
        void qc.invalidateQueries({ queryKey: ['character', 'motions'] });
        void qc.invalidateQueries({ queryKey: ['mmd', 'list'] });
      }
      running = s.running;
      setSync(s);
    };
    getBridge()
      .mmd.syncState()
      .then((s) => !pushed && apply(s), () => {});
    return getBridge().mmd.onSync((s) => {
      pushed = true;
      apply(s);
    });
  }, [canAvatar, qc]);
  return sync;
}
