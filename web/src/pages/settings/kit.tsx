import { useId, useRef, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Spinner } from '../../ui';
import styles from './kit.module.css';
import status from './status.module.css';

// The settings panel's own controls, drawn after the game's ToggleSetting, DropDownSettingPC, ButtonSetting and DisabledBtn.

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export interface SegOpt {
  value: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

/** Segmented switch: a grey track, the chosen option under a white knob that slides 200 ms; role=radiogroup, ←→ Home End. */
export function Seg({ label, value, options, disabled, narrow, onChange }: { label: string; value: string; options: SegOpt[]; disabled?: boolean; narrow?: boolean; onChange: (v: string) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const sel = options.findIndex((o) => o.value === value);
  const enabled = disabled ? [] : options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const tabStop = sel >= 0 && enabled.includes(sel) ? sel : (enabled[0] ?? -1);
  const pick = (i: number) => {
    const o = options[i];
    if (!o || !enabled.includes(i)) return;
    if (o.value !== value) onChange(o.value);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.indexOf(sel));
    const step = NEXT[e.key];
    const t = step ? enabled[(pos + step + enabled.length) % enabled.length] : e.key === 'Home' ? enabled[0] : e.key === 'End' ? enabled.at(-1) : undefined;
    if (t === undefined) return;
    e.preventDefault();
    pick(t);
  };
  const place = { '--n': options.length, '--i': Math.max(0, sel) } as CSSProperties;
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={styles.seg} data-narrow={narrow || undefined} style={place} onKeyDown={onKeyDown}>
      {sel >= 0 && <i className={styles.knob} aria-hidden="true" />}
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === sel}
          disabled={disabled || o.disabled}
          title={o.disabled ? o.disabledReason : undefined}
          tabIndex={i === tabStop ? 0 : -1}
          onClick={() => pick(i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 开 | 关 on the same 200-wide track; one control, role=switch, a click flips it. */
export function OnOff({ on, label, disabled, disabledReason, onChange }: { on: boolean; label: string; disabled?: boolean; disabledReason?: string; onChange: (on: boolean) => void }) {
  const reasonId = useId();
  const why = disabled && disabledReason;
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-describedby={why ? reasonId : undefined}
        title={why || undefined}
        className={styles.seg}
        data-narrow=""
        data-switch=""
        style={{ '--n': 2, '--i': on ? 0 : 1 } as CSSProperties}
        onClick={() => !disabled && onChange(!on)}
      >
        <i className={styles.knob} aria-hidden="true" />
        <span aria-hidden="true" data-on={on || undefined}>
          开
        </span>
        <span aria-hidden="true" data-on={!on || undefined}>
          关
        </span>
      </button>
      {why && (
        <span id={reasonId} hidden>
          {disabledReason}
        </span>
      )}
    </>
  );
}

export interface CapProps {
  children: ReactNode;
  /** acc: the view's one yellow main button; red: deletes. */
  tone?: 'acc' | 'red';
  /** Large (footer and confirm card). */
  lg?: boolean;
  /** Opens another page or the system: the » suffix. */
  go?: boolean;
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
  onClick?: () => void;
}

/** Capsule button (ButtonSetting): white fill, a dark ring past a seam, a drop shadow and contour rings at the right end. */
export function Cap({ children, tone, lg, go, loading, disabled, disabledReason, label, onClick }: CapProps) {
  const off = disabled || loading;
  return (
    <button
      type="button"
      className={styles.cap}
      data-tone={tone}
      data-lg={lg || undefined}
      data-go={go || undefined}
      aria-label={label}
      aria-disabled={off || undefined}
      aria-busy={loading || undefined}
      title={disabled ? disabledReason : undefined}
      onClick={() => !off && onClick?.()}
    >
      <span className={styles.ct} aria-hidden="true" />
      {loading && <Spinner label="正在处理" />}
      {children}
      {go && (
        <span className={styles.arr} aria-hidden="true">
          »
        </span>
      )}
    </button>
  );
}

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
        <button type="button" className={styles.lnk} onClick={link.onClick}>
          {link.label}
        </button>
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

/** Underlined text link, yellow underline. */
export function Lnk({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.lnk} data-danger={danger || undefined} onClick={onClick}>
      {children}
    </button>
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
