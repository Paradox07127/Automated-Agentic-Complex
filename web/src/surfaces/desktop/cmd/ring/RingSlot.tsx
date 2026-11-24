import { useEffect, useRef, useState } from 'react';
import { getBridge, type AvatarAction } from '../../../../bridge';
import type { WheelPress } from '../../../../ui/game/GameWheel';
import type { CommandSlotProps } from '../../types';
import { actionItems, giftOff, pendingCount, poseItems, wheelItems, type CmdItem, type CmdLevel } from '../actions';
import { CommandRing, WHEEL_BOX } from './CommandRing';
import { runCmdAction } from './run';
import styles from './RingSlot.module.css';

/** Her wheel, centred where she was right-clicked. 动作 and 姿态 open their level in place; any other chosen item closes the
 *  panel, and its receipt goes to her bubble. */
export function RingSlot({ state, presence, command, close }: CommandSlotProps) {
  const bridge = getBridge();
  const [round, setRound] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Every open starts from the first level with nothing selected.
  const [at, setAt] = useState<{ x: number; y: number } | undefined>(undefined);
  const [press, setPress] = useState<WheelPress | undefined>(undefined);
  const [level, setLevel] = useState<CmdLevel | null>(null);
  useEffect(() => {
    if (command?.kind !== 'open' || command.mode !== 'ring') return;
    setAt(command.at);
    setPress(undefined);
    setLevel(null);
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

  // Each open reads her action list and setlist again: a gift action she lacks greys 送礼物 with why, and the list names
  // 动作's dances. Unread, 送礼物 stays open and 动作 has no dances.
  const [actions, setActions] = useState<AvatarAction[] | null>(null);
  const [setlist, setSetlist] = useState<string[]>([]);
  const who = state?.character?.id ?? null;
  useEffect(() => {
    if (!bridge.capabilities.avatar) return;
    let live = true;
    bridge.avatar.actions().then(
      (list) => live && setActions(list),
      () => live && setActions(null),
    );
    // The setlist of the character the ring names; another one current by then is refused.
    if (who === null) setSetlist([]);
    else
      bridge.character.getPlaylist(who).then(
        (list) => live && setSetlist(list.items),
        () => live && setSetlist([]),
      );
    return () => {
      live = false;
    };
  }, [bridge, round, who]);

  const run = (item: CmdItem) => {
    if (item.id === 'actions' || item.id === 'poses') setLevel(item.id);
    else
      void runCmdAction({ ...item, id: item.id }, { bridge, state, now: Date.now }).then((o) => {
        if (o.kind === 'receipt') bridge.desktop.notice(o.text);
        if (mounted.current) close();
      });
  };

  const names = actions ?? [];
  const items =
    level === 'poses'
      ? poseItems(state)
      : level === 'actions'
        ? actionItems(state, setlist, names, actions ? giftOff(actions) : null)
        : wheelItems(state, pendingCount(presence), Date.now(), names);
  // A level's centre names the slot that opened it: 07 on the level above.
  const center =
    level === null
      ? { en: 'AGENTIC COMPLEX', name: state?.character?.name ?? '角色', desc: '待命' }
      : { en: '07', name: level === 'actions' ? '动作' : '姿态', desc: '' };
  return (
    <div data-slot="ring" className={styles.box} style={{ width: WHEEL_BOX, height: WHEEL_BOX }}>
      <CommandRing
        key={round}
        items={items}
        center={center}
        level={level ?? undefined}
        at={at}
        press={press}
        onRun={run}
        onBack={level === null ? undefined : () => setLevel(level === 'poses' ? 'actions' : null)}
        onClose={close}
      />
    </div>
  );
}
