import type { CSSProperties, ReactNode } from 'react';
import { keyText } from '../../bridge/platformText';
import { Breath, Icon, Kbd, type IconName } from '../../ui';
import type { Box } from './geometry';
import { SQUARE } from './outlines';
import { Slab, unit } from './Slab';
import { useKeyHover } from './watchMotion';
import styles from './Tiles.module.css';

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });

export interface KeyProps {
  box: Box;
  /** Outline in the key's own px; button_bg01's square when not given. */
  pts?: ReadonlyArray<readonly [number, number]>;
  /** Where the icon and name centre, in the key's own px; the box's centre when not given. */
  mid?: readonly [number, number];
  /** The large left keys carry a larger icon and name. */
  big?: boolean;
  icon: IconName;
  /** The page name (or the action's name). */
  title: string;
  hotkey?: string | undefined;
  /** Why it cannot run on this shell; the key is then disabled. */
  off?: string | undefined;
  /** data-g key the watch entrance drives (the left keys; the right ones flash by group). */
  g?: string;
  onClick: () => void;
}

/** Key face height above its plate: the game's Btn sits 30 game px (13–15 stage px) above its Shadow; 24 so the face
 *  still clears its plate in the smallest window, where the tilt shortens the gap. */
const KEY_DEPTH = 24;
/** Where the plate shows: a left key's Btn sits at (-3.7, 2.4) from its Shadow, a right key's at (6, 0.6) (game px, y up). */
const SHIFT_BIG = [1.85, 1.2] as const;
const SHIFT_SQUARE = [-2.5, 0.25] as const;

/** A watch key: a light slab standing on the face, icon over name; it rises on hover and sinks when pressed. */
export function WatchKey({ box, pts, mid, big, icon, title, hotkey, off, g, onClick }: KeyProps) {
  const hover = useKeyHover<HTMLButtonElement>();
  const [mx, my] = mid ?? [box.width / 2, box.height / 2];
  return (
    <span className={styles.slot} style={at(box)} data-g={g}>
      <button type="button" className={styles.key} data-big={big || undefined} aria-label={title} title={off} disabled={!!off} onClick={onClick} data-g="btn" {...hover}>
        <Slab pts={pts ?? unit(SQUARE, box.width, box.height)} w={box.width} h={box.height} depth={KEY_DEPTH} tone="light" contour={big} shift={big ? SHIFT_BIG : SHIFT_SQUARE} g="face">
          <span className={styles.face} style={{ left: mx, top: my }} aria-hidden="true">
            <span className={styles.icon} data-g="icon">
              <Icon name={icon} size={32} />
            </span>
            <span className={styles.name} data-g="label">
              {title}
            </span>
          </span>
          {hotkey && (
            <span className={styles.hot}>
              <Kbd>{keyText(hotkey)}</Kbd>
            </span>
          )}
        </Slab>
      </button>
    </span>
  );
}

/** A right-hand key group: the entrance flashes and brings it forward as one. */
export function Group({ g, children }: { g: string; children: ReactNode }) {
  return (
    <div className={styles.group} data-g={g}>
      {children}
    </div>
  );
}

export interface TopIconProps {
  box: Box;
  icon: IconName;
  label: string;
  /** The red dot; it breathes only while the window has focus. */
  dot?: 'live' | 'still';
  g: string;
  /** Its name under the icon. */
  named?: boolean;
  onClick: () => void;
}

/** A top-left icon, flat on the face as the game's are: the icon over its name, a grey bar under both, the red dot. */
export function TopIcon({ box, icon, label, dot, g, named, onClick }: TopIconProps) {
  return (
    <span className={styles.slot} style={at(box)} data-g={g}>
      <button type="button" className={styles.top} aria-label={label} title={label} onClick={onClick}>
        <span className={styles.topIcon} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        {named && (
          <span className={styles.topName} aria-hidden="true">
            {label}
          </span>
        )}
        {dot && <span className={styles.dot}>{dot === 'live' ? <Breath size={6} /> : <span className={styles.still} />}</span>}
        <span className={styles.bar} aria-hidden="true" />
      </button>
    </span>
  );
}
