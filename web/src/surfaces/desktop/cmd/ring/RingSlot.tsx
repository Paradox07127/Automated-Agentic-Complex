import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../../../bridge';
import type { Severity } from '../../../../domain';
import { Toast } from '../../../../ui';
import { useCommand } from '../../hooks/useCommand';
import type { CommandSlotProps } from '../../types';
import { pendingCount, ringItems, type CmdItem } from '../actions';
import { CommandRing } from './CommandRing';
import { runCmdAction } from './run';
import styles from './RingSlot.module.css';

type View = { kind: 'ring' } | { kind: 'receipt'; text: string; tone: Severity };

/** 指令环 beside her. A chosen item closes the panel or shows its receipt until the toast ends; 快速输入 opens in the bubble. */
export function RingSlot({ state, presence, close }: CommandSlotProps) {
  const bridge = getBridge();
  const command = useCommand();
  const [view, setView] = useState<View>({ kind: 'ring' });
  const [round, setRound] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Every open starts from the ring with nothing selected.
  useEffect(() => {
    if (command?.kind !== 'open' || command.mode !== 'ring') return;
    setView({ kind: 'ring' });
    setRound((r) => r + 1);
  }, [command]);

  const run = (item: CmdItem) =>
    void runCmdAction(item, { bridge, state, now: Date.now }).then((o) => {
      if (!mounted.current) return;
      if (o.kind === 'input') void bridge.desktop.action('quickInput').catch(() => {});
      if (o.kind === 'close' || o.kind === 'input') return close();
      setView(o);
    });

  let body;
  if (view.kind === 'receipt')
    body = (
      <div className={styles.receipt} data-region="">
        <Toast message={view.text} severity={view.tone} onClose={close} />
      </div>
    );
  else body = <CommandRing key={round} items={ringItems(state)} pending={pendingCount(presence)} keys={state?.hotkeys} onRun={run} onClose={close} />;
  return <div data-slot="ring">{body}</div>;
}
