import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../../../bridge';
import type { Severity } from '../../../../domain';
import { Toast } from '../../../../ui';
import type { CommandSlotProps } from '../../types';
import { pendingCount, wheelItems, type CmdItem } from '../actions';
import { CommandRing, WHEEL_BOX } from './CommandRing';
import { runCmdAction } from './run';
import styles from './RingSlot.module.css';

type View = { kind: 'ring' } | { kind: 'receipt'; text: string; tone: Severity };

/** Her wheel, centred where she was right-clicked. A chosen item closes the panel or shows its receipt until the toast ends. */
export function RingSlot({ state, presence, command, close }: CommandSlotProps) {
  const bridge = getBridge();
  const [view, setView] = useState<View>({ kind: 'ring' });
  const [round, setRound] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Every open starts from the wheel with nothing selected.
  const [at, setAt] = useState<{ x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    if (command?.kind !== 'open' || command.mode !== 'ring') return;
    setView({ kind: 'ring' });
    setAt(command.at);
    setRound((r) => r + 1);
  }, [command]);

  const run = (item: CmdItem) =>
    void runCmdAction(item, { bridge, state, now: Date.now }).then((o) => {
      if (!mounted.current) return;
      if (o.kind === 'close') return close();
      setView(o);
    });

  const center = { en: 'AGENTIC COMPLEX', name: state?.character?.name ?? '她', desc: '待命' };
  return (
    <div data-slot="ring" className={styles.box} style={{ width: WHEEL_BOX, height: WHEEL_BOX }}>
      {view.kind === 'receipt' ? (
        <div className={styles.receipt} data-region="">
          <Toast message={view.text} severity={view.tone} onClose={close} />
        </div>
      ) : (
        <CommandRing key={round} items={wheelItems(state, pendingCount(presence))} center={center} at={at} onRun={run} onClose={close} />
      )}
    </div>
  );
}
