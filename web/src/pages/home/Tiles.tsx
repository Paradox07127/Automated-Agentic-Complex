import type { CSSProperties, ReactNode } from 'react';
import { Breath, Icon, Kbd, type IconName } from '../../ui';
import type { Box } from './geometry';
import { useKeyHover } from './watchMotion';
import styles from './Tiles.module.css';

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });

export interface KeyProps {
  /** `sq` is button_bg01 on the right; 1–4 are the left column's rightbutton_bg01–04. */
  shape: 'sq' | 1 | 2 | 3 | 4;
  box: Box;
  icon: IconName;
  /** The page name (or the action's name). */
  title: string;
  hotkey?: string | undefined;
  /** data-g key the watch entrance drives (the left keys; the right ones flash by group). */
  g?: string;
  onClick: () => void;
}

/** A watch key: shadow plate, the face offset on it, icon over name; floats toward the viewer on hover. */
export function WatchKey({ shape, box, icon, title, hotkey, g, onClick }: KeyProps) {
  const hover = useKeyHover<HTMLButtonElement>();
  const sq = shape === 'sq';
  return (
    <span className={styles.slot} style={at(box)} data-g={g}>
      <button type="button" className={styles.key} data-shape={shape} aria-label={title} onClick={onClick} data-g="btn" {...hover}>
        <span className={styles.shadow} aria-hidden="true" />
        <span className={styles.face} data-g="face" aria-hidden="true">
          <span className={styles.fill} />
          <span className={styles.icon} data-g="icon">
            <Icon name={icon} size={sq ? 20 : 24} />
          </span>
          <span className={styles.name} data-g="label">
            {title}
          </span>
          {hotkey && (
            <span className={styles.hot}>
              <Kbd>{hotkey}</Kbd>
            </span>
          )}
        </span>
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
  /** Why it cannot run on this shell; the icon is then disabled. */
  off?: string | undefined;
  /** Its name under the icon. */
  named?: boolean;
  onClick: () => void;
}

/** A small top-left icon (mail / notice): the icon over its shadow and a bar underneath. */
export function TopIcon({ box, icon, label, dot, g, off, named, onClick }: TopIconProps) {
  return (
    <span className={styles.slot} style={at(box)} data-g={g}>
      <button type="button" className={styles.top} data-named={named || undefined} aria-label={label} title={off ?? label} disabled={!!off} onClick={onClick}>
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
