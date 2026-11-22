import { useState } from 'react';
import { formatClock } from '../../domain';
import { navigate } from '../../shell/nav';
import { MessageText } from './MessageText';
import { useMessageMenu, type MessageMenuProps } from './MessageMenu';
import { TURN_SOURCE, TURN_STATE } from './stream';
import type { TiMem, TurnRes } from './turnTrace';
import styles from './Messages.module.css';

/** A reply's `/trace/turns` row paired by turn_id; the chat no longer shows it, 运行记录 does. */
export interface TurnTagInfo {
  no: number;
  res: TurnRes;
  ms: number;
  ttft?: number | null;
  provider?: string | null;
  account_label?: string | null;
}

export interface TextMessageProps extends MessageMenuProps {
  mine: boolean;
  at: number;
  text: string;
  roleName: string;
  latest?: boolean;
  /** Turn end state; cancelled, interrupted and failed show at the reply's end. */
  state?: string;
  /** Turn source; anything but typed text is read out with the time. */
  source?: string;
  /** Live reply still coming in. */
  streaming?: boolean;
  /** The reply's trace row; not drawn in the chat. */
  turn?: TurnTagInfo | null;
  /** Its turn is open in 轮次详情. */
  selected?: boolean;
  mems?: TiMem[];
  learned?: TiMem[];
  /** Her head picture; without it her head shows the first character of `roleName`. */
  headUrl?: string | undefined;
  /** First of consecutive messages by this speaker: the head and the bubble's turned-out corner. */
  first?: boolean;
  /** Came in while the page was open: plays the cell entrance. */
  fresh?: boolean;
  /** Her line's line_id and the turn's turn_id, for the right-click menu. */
  lineId?: string | undefined;
  turnId?: string | undefined;
}

/** The two broken arcs and the dot around a head (proto `svg.ring`). */
function Ring() {
  return (
    <svg className={styles.ring} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M50.5 13.5A26 26 0 0 0 10 22" />
      <path d="M8.6 30A26 26 0 0 0 20 54" />
      <path d="M27 57.6A26 26 0 0 0 57.6 27" />
      <circle cx="54" cy="14" r="1.6" />
    </svg>
  );
}

/** A round head on a halftone disc inside the broken ring: the picture, else the name's first character, else the plain figure (the user). */
export function Head({ name, url }: { name?: string | undefined; url?: string | undefined }) {
  const [failed, setFailed] = useState<string | null>(null);
  const initial = name ? [...name][0] : undefined;
  return (
    <span className={styles.ava} data-head="" aria-hidden="true">
      <span className={styles.face}>
        {url && failed !== url ? <img src={url} alt="" onError={() => setFailed(url)} /> : initial ? <span className={styles.initial}>{initial}</span> : <i className={styles.generic} />}
      </span>
      <Ring />
    </span>
  );
}

/** 「新增记忆 n 条」「引用记忆 n 条」 chips under her reply. */
export function MemTags({ mems = [], learned = [] }: { mems?: TiMem[]; learned?: TiMem[] }) {
  return (
    <>
      {learned.length > 0 && (
        <button type="button" className={styles.chip} data-new="" onClick={() => navigate({ page: 'memory', view: 'about', sel: learned[0]?.id ?? '' })}>
          + 新增记忆 <span className="num">{learned.length}</span> 条
        </button>
      )}
      {mems.length > 0 && (
        <button type="button" className={styles.chip} onClick={() => navigate({ page: 'memory', view: 'about', sel: mems[0]?.id ?? '' })}>
          引用记忆 <span className="num">{mems.length}</span> 条
        </button>
      )}
    </>
  );
}

/** Who and when, for screen readers; the page shows time only as lines between messages. */
export function Who({ name, at, via }: { name: string; at: number; via?: string | undefined }) {
  return (
    <span className={styles.sr}>
      <span>{name}</span> {`${formatClock(at)}${via ? ` │ ${via}` : ''}`}
    </span>
  );
}

/** User line (dark bubble on the right) or her reply (bubble beside her head on the left), with her memory chips below. */
export function TextMessage({ mine, at, text, roleName, latest, state, source, streaming, turn: _turn, selected, mems, learned, headUrl, first = true, fresh, lineId, turnId, ...menuProps }: TextMessageProps) {
  const via = source ? TURN_SOURCE[source] : undefined;
  const ended = state ? TURN_STATE[state] : undefined;
  const tags = !mine && ((mems?.length ?? 0) > 0 || (learned?.length ?? 0) > 0);
  const { onContextMenu, onKeyDown, menu } = useMessageMenu(text, { line: mine ? undefined : lineId, turn: turnId }, menuProps);
  return (
    <div className={styles.msg} data-kind={mine ? 'me' : 'ai'} data-first={first || undefined} data-latest={latest || undefined} data-sel={selected || undefined} data-new={fresh || undefined}>
      <Who name={mine ? '用户' : roleName} at={at} via={via} />
      {first && <Head name={mine ? undefined : roleName} url={mine ? undefined : headUrl} />}
      <div className={styles.stack}>
        <div className={styles.bub} data-first={first || undefined} tabIndex={0} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
          {(text || streaming) && <MessageText text={text} streaming={streaming} />}
          {ended && <p className={styles.ended}>■ {ended}</p>}
        </div>
        {tags && (
          <span className={styles.foot}>
            <MemTags mems={mems} learned={learned} />
          </span>
        )}
      </div>
      {menu}
    </div>
  );
}
