import type { InputHTMLAttributes, ReactNode } from 'react';
import { Btn } from '../../ui';
import styles from './kit.module.css';
import status from './status.module.css';

// The settings panel's own fields and marks, drawn after the game's DisabledBtn and KeySetting; switches, segments and buttons are the shared ones.

/** White capsule text field. */
export function Field(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={styles.fld}>
      <input {...props} />
    </span>
  );
}

/** A field-shaped readout for a stored secret that is never read back. */
export function Masked({ children }: { children: ReactNode }) {
  return (
    <span className={styles.fld}>
      <span className={styles.mask}>{children}</span>
    </span>
  );
}

/** DisabledBtn: the whole control swapped for a plate with a ban sign and the reason. */
export function Dis({ children, link }: { children: ReactNode; link?: { label: string; onClick: () => void } }) {
  return (
    <span className={styles.dis} role="note">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fillRule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM6.6 8.7a6.5 6.5 0 0 0 8.7 8.7zM8.7 6.6l8.7 8.7a6.5 6.5 0 0 0-8.7-8.7z" fill="currentColor" />
      </svg>
      <span>{children}</span>
      {link && (
        <Btn variant="link" onClick={link.onClick}>
          {link.label}
        </Btn>
      )}
    </span>
  );
}

export type StTone = 'ok' | 'bad' | 'warn' | 'off';

/** A state as a shape and words: ● fine, ▲ broken, ◆ waiting, ■ off. */
export function St({ tone, children }: { tone: StTone; children?: ReactNode }) {
  return (
    <span className={status.st} data-tone={tone}>
      {children}
    </span>
  );
}

/** A small framed chip: a permission a band needs (✕ when missing), a lock, a capability. */
export function Chip({ tone, children }: { tone?: 'on' | 'off' | 'miss' | 'lock'; children: ReactNode }) {
  return (
    <span className={status.chip} data-tone={tone}>
      {children}
    </span>
  );
}

/** Fixed key caps of a hot key (KeySetting cell); `warn` is a clash. */
export function KeyCell({ keys, warn, recording, none }: { keys?: string[]; warn?: boolean; recording?: boolean; none?: boolean }) {
  if (recording)
    return (
      <span className={styles.key} data-rec="" role="status">
        按下新快捷键，Esc 取消
      </span>
    );
  if (none || !keys?.length) return <span className={styles.key} data-none="">未设置</span>;
  return (
    <span className={styles.key} data-warn={warn || undefined}>
      {keys.map((k, i) => (
        <kbd key={`${k}${i}`}>{k}</kbd>
      ))}
    </span>
  );
}
