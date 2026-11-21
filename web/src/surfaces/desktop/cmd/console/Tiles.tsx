import { useRef, useState } from 'react';
import { getBridge, type DesktopState } from '../../../../bridge';
import { formatClock } from '../../../../domain';
import { Toggle } from '../../../../ui';
import { ringItems, type CmdActionId } from '../actions';
import { runCmdAction } from '../ring/run';
import styles from './ConsoleSlot.module.css';

function State({ label, value, on, disabled, onChange }: { label: string; value?: string | undefined; on: boolean; disabled: boolean; onChange: () => void }) {
  return (
    <div className={styles.state}>
      <span>{label}{value && <small>{value}</small>}</span>
      <Toggle size="sm" on={on} label={label} disabled={disabled} disabledReason="当前无法修改" onChange={onChange} />
    </div>
  );
}

/** Less frequently changed desktop controls remain available behind one disclosure. */
export function States({ state, offline, say }: { state: DesktopState | null; offline: boolean; say: (s: string) => void }) {
  const bridge = getBridge();
  const active = useRef<CmdActionId | null>(null);
  const [working, setWorking] = useState(false);
  const now = Date.now();
  const items = ringItems(state, now);
  const run = async (id: CmdActionId) => {
    const item = items.find((i) => i.id === id);
    if (!item || active.current != null) return;
    active.current = id;
    setWorking(true);
    try {
      const outcome = await runCmdAction(item, { bridge, state, now: Date.now });
      if (outcome.kind === 'receipt') say(outcome.text);
      else if (id === 'show') say('角色已显示');
    } finally {
      active.current = null;
      setWorking(false);
    }
  };
  const quiet = state?.quietUntil != null && state.quietUntil > now ? state.quietUntil : null;
  const pass = state?.clickThroughAll ?? false;
  const shown = !(state?.hidden ?? false);
  return (
    <div className={styles.states} role="group" aria-label="桌面选项">
      <State label="显示角色" on={shown} disabled={!state || working} onChange={() => void run(shown ? 'hide' : 'show')} />
      <State label="免打扰" value={quiet != null ? `到 ${formatClock(quiet)}` : undefined} on={quiet != null} disabled={!state || offline || working} onChange={() => void run(quiet == null ? 'quiet' : 'quietEnd')} />
      <State label="全部点穿" on={pass} disabled={!state || working} onChange={() => void run('pass')} />
    </div>
  );
}
