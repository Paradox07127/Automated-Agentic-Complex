import { useEffect, useState } from 'react';
import { GameWheel, type GameWheelCenter } from '../../../../ui/game/GameWheel';
import type { CmdItem } from '../actions';

/** The wheel's page is a square of this many CSS px (GameWheel's box; DesktopLayout's `WHEEL_PANEL`). */
export const WHEEL_BOX = 520;

export interface CommandRingProps {
  items: CmdItem[];
  center: GameWheelCenter;
  /** Where she was right-clicked, in the page; the hot key's wheel has none and sits in the middle. */
  at?: { x: number; y: number } | undefined;
  onRun: (item: CmdItem) => void;
  onClose: () => void;
}

/** ⌘ held: the key help line under the wheel shows. */
function useCommandHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setHeld(e.metaKey || e.key === 'Meta');
    const off = (e: KeyboardEvent) => setHeld(e.key === 'Meta' ? false : e.metaKey);
    const clear = () => setHeld(false);
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', off);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('keyup', off);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return held;
}

/** Her wheel, the right click's and the hot key's alike: one level of 8 slots, a pick runs at once. Dark in both themes. */
export function CommandRing({ items, center, at, onRun, onClose }: CommandRingProps) {
  const keys = useCommandHeld();
  return (
    <div data-theme="dark" data-keys={keys || undefined} data-region="" style={{ position: 'relative', width: WHEEL_BOX, height: WHEEL_BOX }}>
      <GameWheel
        items={items}
        center={center}
        origin={at}
        bounds={{ width: WHEEL_BOX, height: WHEEL_BOX }}
        label="她的轮盘"
        onRun={(id) => {
          const item = items.find((i) => i.id === id);
          if (item) onRun(item);
        }}
        onClose={onClose}
      />
    </div>
  );
}
