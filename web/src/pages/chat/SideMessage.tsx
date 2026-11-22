import { Btn } from '../../ui';
import { MessageText } from './MessageText';
import { useMessageMenu, type MessageMenuProps } from './MessageMenu';
import { Head, Who } from './TextMessage';
import styles from './Messages.module.css';

export interface SideMessageProps extends MessageMenuProps {
  at: number;
  text: string;
  streaming?: boolean;
  roleName: string;
  /** Title of the foreground task when this answer started. */
  frontTitle: string | null;
  onFront: () => void;
  onQueue: () => void;
  /** Her head picture; without it the first character of `roleName`. */
  headUrl?: string | undefined;
  /** First of consecutive messages by this speaker. */
  first?: boolean;
  /** Came in while the page was open. */
  fresh?: boolean;
  /** The side line's line_id, for 在桌面上重放表情. */
  lineId?: string | undefined;
}

/** Side answer while the foreground runs: her bubble under the 「旁路」 tag and 只读, a link up to the task, 「派发任务」. */
export function SideMessage({ at, text, streaming, roleName, frontTitle, onFront, onQueue, headUrl, first = true, fresh, lineId, ...menuProps }: SideMessageProps) {
  const { onContextMenu, onKeyDown, menu } = useMessageMenu(text, { line: lineId }, menuProps);
  return (
    <div className={styles.msg} data-kind="side" data-first={first || undefined} data-new={fresh || undefined} aria-label="旁路对话回答">
      <Who name={roleName} at={at} />
      {first && <Head name={roleName} url={headUrl} />}
      <div className={styles.stack}>
        <span className={styles.sideHead}>
          <span className={styles.tag}>旁路</span>
          <span>只读</span>
        </span>
        {frontTitle && (
          <button type="button" className={styles.up} onClick={onFront}>
            ↑ 触发时前台：{frontTitle}
          </button>
        )}
        <div className={styles.bub} data-first={first || undefined} tabIndex={0} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
          <MessageText text={text} streaming={streaming} />
        </div>
        <div className={styles.actions}>
          <Btn size="sm" variant="ghost" icon="plus" onClick={onQueue}>
            派发任务
          </Btn>
          <span className={styles.cap}>旁路只读，不修改文件</span>
        </div>
      </div>
      {menu}
    </div>
  );
}
