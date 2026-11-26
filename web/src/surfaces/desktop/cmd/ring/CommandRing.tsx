import { useEffect, useState } from 'react';
import { shellPlatform } from '../../../../bridge/platformText';
import { GameWheel, type GameWheelCenter, type WheelPress } from '../../../../ui/game/GameWheel';
import type { CmdItem } from '../actions';

/** The wheel's page is a square of this many CSS px (GameWheel's box; DesktopLayout's `WHEEL_PANEL`). */
export const WHEEL_BOX = 520;

export interface CommandRingProps {
  /** The level's 8 slots clockwise from the top; null leaves a slot empty. */
  items: readonly (CmdItem | null)[];
  center: GameWheelCenter;
  /** The level under the first that shows; it turns in anew when it changes. */
  level?: string | undefined;
  /** Where she was right-clicked, in the page; the hot key's wheel has none and sits in the middle. */
  at?: { x: number; y: number } | undefined;
  /** The held right button that opened it, as the shell forwards it. */
  press?: WheelPress | undefined;
  onRun: (item: CmdItem) => void;
  /** Under the first level: its centre, Esc and Backspace go one level up. */
  onBack?: (() => void) | undefined;
  onClose: () => void;
}

/** ⌘ held, Ctrl on Windows (where ⌘ is the Windows key): the key help line under the wheel shows. */
function useCommandHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const [key, down] = shellPlatform() === 'windows' ? (['Control', (e: KeyboardEvent) => e.ctrlKey] as const) : (['Meta', (e: KeyboardEvent) => e.metaKey] as const);
    const on = (e: KeyboardEvent) => setHeld(down(e) || e.key === key);
    const off = (e: KeyboardEvent) => setHeld(e.key === key ? false : down(e));
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

/** Her wheel, the right click's and the hot key's alike: 8 slots a level, a pick runs at once or opens the next level in
 *  place. Dark in both themes. */
export function CommandRing({ items, center, level, at, press, onRun, onBack, onClose }: CommandRingProps) {
  const keys = useCommandHeld();
  return (
    <div data-theme="dark" data-keys={keys || undefined} data-region="" style={{ position: 'relative', width: WHEEL_BOX, height: WHEEL_BOX }}>
      <GameWheel
        items={items}
        center={center}
        origin={at}
        press={press}
        bounds={{ width: WHEEL_BOX, height: WHEEL_BOX }}
        label="角色的轮盘"
        level={level}
        onRun={(_, i) => {
          const item = items[i];
          if (item) onRun(item);
        }}
        onBack={onBack}
        onClose={onClose}
      />
    </div>
  );
}
