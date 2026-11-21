import { Btn, Toggle } from '../../../ui';
import type { ChainRow as Row } from './graph';
import styles from './MotionSettings.module.css';

export const REQUIRED_TEXT = '基础动作，不能关';

export interface ChainRowProps {
  row: Row;
  on: boolean;
  /** Toggled since the last save. */
  unsaved: boolean;
  /** Why the avatar did not take the saved switch; null when it did. */
  adjusted: string | null;
  /** Why the switches are locked; null when they are not. */
  lock: string | null;
  /** Why 在桌面上播一次 cannot run; null when it can. */
  playBlock: string | null;
  /** The user's note on the chain; '' when none. */
  note: string;
  onToggle: (on: boolean) => void;
  onPlay: () => void;
  onOpen: () => void;
}

/** One chain: its start's name, clips, group and default │ details, play once, switch │ the reason the avatar gave │ the note. */
export function ChainRow({ row: r, on, unsaved, adjusted, lock, playBlock, note, onToggle, onPlay, onOpen }: ChainRowProps) {
  const why = r.required ? REQUIRED_TEXT : lock;
  return (
    <li className={styles.row} data-chain={r.key} data-off={!on || undefined}>
      <span className={styles.nm}>
        <b title={r.key}>{r.label}</b>
        {r.isNew && <span className={styles.tag}>新</span>}
        {unsaved && <i className={styles.chg} title="未保存" aria-label="未保存" />}
      </span>
      <span className={styles.meta}>
        <span>{r.groupTitle}</span>
        <span>{r.def ? '默认开' : '默认关'}</span>
        {on !== r.def && <span className={styles.tag}>已改</span>}
      </span>
      <span className={styles.clips} title={r.clips.join(' → ')}>
        {r.clips.join(' → ')}
      </span>
      <span className={styles.ctl}>
        <Btn size="sm" variant="quiet" onClick={onOpen}>
          详情
        </Btn>
        <Btn size="sm" variant="quiet" disabled={playBlock != null} {...(playBlock != null ? { disabledReason: playBlock } : {})} onClick={onPlay}>
          在桌面上播一次
        </Btn>
        <Toggle size="sm" on={on} label={r.label} disabled={why != null} disabledReason={why ?? ''} onChange={onToggle} />
      </span>
      {(r.required || adjusted) && (
        <span className={styles.why} data-adjusted={adjusted != null || undefined}>
          {adjusted ?? REQUIRED_TEXT}
        </span>
      )}
      {note && (
        <span className={styles.note} title={note}>
          备注：{note}
        </span>
      )}
    </li>
  );
}
