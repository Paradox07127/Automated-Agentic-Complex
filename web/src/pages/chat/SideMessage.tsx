import { formatClock } from '../../domain';
import { Btn } from '../../ui';
import { MessageText } from './MessageText';
import { ProviderLine, useCardShape, WhoAva, type TurnTagInfo } from './TextMessage';
import styles from './Messages.module.css';

export interface SideMessageProps {
  at: number;
  text: string;
  streaming?: boolean;
  roleName: string;
  model?: Pick<TurnTagInfo, 'provider' | 'account_label'>;
  /** Title of the foreground task when this answer started. */
  frontTitle: string | null;
  onFront: () => void;
  onQueue: () => void;
  /** Speaker's character id; with `first` her round head goes before the name. */
  roleId?: string | null | undefined;
  /** First of consecutive messages by this speaker. */
  first?: boolean;
}

/** Side answer while the foreground runs: an other row whose name carries the 「旁路」 tag (GroupOwnerNode), 只读 by the time, a link up to the task, 「派发任务」. */
export function SideMessage({ at, text, streaming, roleName, model, frontTitle, onFront, onQueue, roleId, first = true }: SideMessageProps) {
  const card = useCardShape(text);
  return (
    <div className={styles.msg} data-kind="side" data-shape={card ? 'card' : 'bubble'} data-first={first || undefined} aria-label="旁路对话回答">
      <div className={styles.who} data-ava={first || undefined}>
        {first && <WhoAva roleId={roleId} />}
        <span className={styles.name}>{roleName}</span>
        <span className={styles.tag}>旁路</span>
        <span className={styles.tm}>{formatClock(at)}</span>
        <span className={styles.tm}>只读</span>
        {model && <ProviderLine {...model} />}
      </div>
      {frontTitle && (
        <button type="button" className={styles.up} onClick={onFront}>
          ↑ 触发时前台：{frontTitle}
        </button>
      )}
      <div className={card ? styles.card : `${styles.bubble} sns-bubble-other`}>
        <div className={styles.body}>
          <MessageText text={text} streaming={streaming} />
        </div>
      </div>
      <div className={styles.actions}>
        <Btn size="sm" variant="ghost" icon="plus" onClick={onQueue}>
          派发任务
        </Btn>
        <span className={styles.cap}>旁路只读，不修改文件</span>
      </div>
    </div>
  );
}
