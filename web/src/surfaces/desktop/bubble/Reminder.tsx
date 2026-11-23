import type { ReminderCard } from './useBubbleCards';
import styles from './Bubble.module.css';

/** 提醒到点: what she was asked to remind; showing it marks it read (`useSeenReceipt`), so it needs no button. */
export function Reminder({ card }: { card: ReminderCard }) {
  return (
    <div className={styles.main} data-kind="reminder">
      <p key={card.id} className={`${styles.text} ${styles.fade}`}>
        {card.title}
      </p>
    </div>
  );
}
