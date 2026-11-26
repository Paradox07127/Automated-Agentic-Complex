import { useEffect, useMemo, useState } from 'react';
import { getBridge, type DesktopState, type ProcessState, type RuntimeProcess, type RuntimeSnapshot } from '../../../bridge';

/** The `state` words desktop.onState sends, to ProcessState names. */
const NATIVE_STATE: Record<string, string> = { port_in_use: 'portInUse' };

function pip(p: RuntimeProcess): ProcessState {
  const state = p.state === 'backoff' ? `backoff(${p.backoff})` : p.state === 'failed' ? `failed(${p.reason})` : (NATIVE_STATE[p.state] ?? p.state);
  return { state, pid: p.pid, backoff: p.backoff };
}

/** The snapshot carries ids only; the name is the one desktop.onState lists for that id, else the id, as native does. */
function withRuntime(s: DesktopState, r: RuntimeSnapshot): DesktopState {
  const id = r.character.current;
  return {
    ...s,
    // null: no switch has reported a character yet, so desktop.onState's stays.
    character: id == null ? s.character : { id, name: [s.character, ...s.characters].find((c) => c?.id === id)?.name ?? id },
    pips: { ...s.pips, agentd: pip(r.processes.agentd), avatar: pip(r.processes.avatar) },
  };
}

/** The desktop state native pushes (`desktop.onState`), with the character and the agentd/avatar pips from `app.runtime`. */
export function useDesktopState(): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  useEffect(() => getBridge().desktop.onState(setState), []);
  useEffect(() => {
    const bridge = getBridge();
    let live = true;
    // A host without app.runtime rejects it, and runtime stays null.
    bridge.app.runtime().then(
      (r) => live && setRuntime((prev) => prev ?? r),
      () => {},
    );
    const off = bridge.app.onRuntime(setRuntime);
    return () => {
      live = false;
      off();
    };
  }, []);
  return useMemo(() => (state && runtime ? withRuntime(state, runtime) : state), [state, runtime]);
}
