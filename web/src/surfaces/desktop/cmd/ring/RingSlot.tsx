import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../../../bridge';
import type { Severity } from '../../../../domain';
import { Toast } from '../../../../ui';
import type { WheelPress } from '../../../../ui/game/GameWheel';
import type { CommandSlotProps } from '../../types';
import { giftOff, pendingCount, wheelItems, type CmdItem } from '../actions';
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
  const [press, setPress] = useState<WheelPress | undefined>(undefined);
  useEffect(() => {
    if (command?.kind !== 'open' || command.mode !== 'ring') return;
    setView({ kind: 'ring' });
    setAt(command.at);
    setPress(undefined);
    setRound((r) => r + 1);
  }, [command]);
  // Its own subscription: each forwarded move counts, not only the last command.
  useEffect(
    () =>
      getBridge().desktop.onCommand((c) => {
        if (c.kind === 'ringPointer') setPress(c.phase === 'up' ? { phase: 'up', x: c.x, y: c.y, ms: c.ms } : { phase: 'move', x: c.x, y: c.y });
      }),
    [],
  );

  // Each open reads her action list again: a gift action she lacks greys 送礼物 with why. Unread, the slot stays open.
  const [gift, setGift] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge.capabilities.avatar) return;
    let live = true;
    bridge.avatar.actions().then(
      (list) => live && setGift(giftOff(list)),
      () => live && setGift(null),
    );
    return () => {
      live = false;
    };
  }, [bridge, round]);

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
        <CommandRing key={round} items={wheelItems(state, pendingCount(presence), Date.now(), gift)} center={center} at={at} press={press} onRun={run} onClose={close} />
      )}
    </div>
  );
}
