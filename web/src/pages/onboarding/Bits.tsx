import styles from './Bits.module.css';

/** Loading bar: the tip over a 2.5 px track, its end cap and the spinning loading icon. */
export function Loading({ tip }: { tip: string }) {
  return (
    <div className={styles.loading} role="status" aria-busy="true">
      <span className={styles.tip}>{tip}</span>
      <span className={`${styles.track} login_loading_bg01`} aria-hidden="true">
        <i className={`${styles.cap} login_loading_bg02`} />
        <i className={`${styles.spin} loading-spinner`} />
      </span>
    </div>
  );
}
