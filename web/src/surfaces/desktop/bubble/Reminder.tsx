import { Btn } from '../../../ui/Btn';
import { Icon } from '../../../ui/Icon';
import type { ReminderCard } from './useBubbleCards';
import styles from './Bubble.module.css';

export interface ReminderProps {
  card: ReminderCard;
  busy: boolean;
  error: string | null;
  onAck: () => void;
  onLater: () => void;
}

/** 提醒到点: the due reminder with 知道了 (完成) and 稍后 (10 分钟), in the thought's place until one is clicked. */
export function Reminder({ card, busy, error, onAck, onLater }: ReminderProps) {
  return (
    <div className={styles.main} data-kind="reminder">
      <div className={styles.row}>
        <span className={styles.ico} aria-hidden="true">
          <Icon name="clock" size={16} />
        </span>
        <p key={card.id} className={`${styles.text} ${styles.fade}`}>
          {card.title}
        </p>
      </div>
      <div className={styles.btns}>
        <Btn variant="primary" size="sm" loading={busy} onClick={onAck}>
          知道了
        </Btn>
        {card.commitment_id && (
          <Btn variant="secondary" size="sm" disabled={busy} onClick={onLater}>
            稍后
          </Btn>
        )}
      </div>
      {error && <p className={styles.err}>{error}</p>}
    </div>
  );
}
