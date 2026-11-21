import styles from './DlgHead.module.css';

/** The SNS dialog header over the thread: conversation title and turn count (decorative; the list row carries the name). */
export function DlgHead({ title, turns }: { title: string; turns: number }) {
  return (
    <div className={styles.dlgHead} aria-hidden="true" data-g="head">
      <span className={styles.dlgName}>{title}</span>
      <span className={styles.dlgSub}>{`${turns} 轮`}</span>
      <span className={styles.tri}>
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
