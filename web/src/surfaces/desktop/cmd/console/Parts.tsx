import { useEffect, useState } from 'react';
import { Btn } from '../../../../ui';
import styles from './ConsoleSlot.module.css';

/** The card's ground: the watch map's contour lines in the top right corner and the brief cards' corner ticks. */
export function Plate() {
  return (
    <>
      <svg className={styles.topo} viewBox="0 0 200 150" aria-hidden="true">
        <path d="M40 0c20 30 70 40 90 70s50 50 70 60" />
        <path d="M70 0c18 24 62 34 80 60s40 40 50 46" />
        <path d="M100 0c14 18 50 26 64 46s28 30 36 34" />
        <path d="M130 0c10 12 34 18 44 32s18 20 26 22" />
        <path d="M160 0c6 8 20 12 26 20s10 12 14 14" />
      </svg>
      {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
        <i key={k} className={styles.tick} data-at={k} aria-hidden="true" />
      ))}
    </>
  );
}

/** 退出 with one step of confirmation in place; Escape or 取消 puts it back. */
export function Foot({ quit }: { quit: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    // Ahead of the panel's own Escape, which would close it.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setAsking(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [asking]);
  if (asking)
    return (
      <footer className={styles.foot} data-confirm="" role="alertdialog" aria-label="退出确认">
        <span className={styles.ask}>退出后后台和她都会停下</span>
        <Btn size="sm" variant="ghost" onClick={() => setAsking(false)}>
          取消
        </Btn>
        <Btn size="sm" variant="danger" onClick={quit}>
          退出
        </Btn>
      </footer>
    );
  return (
    <footer className={styles.foot}>
      <button type="button" className={styles.quit} onClick={() => setAsking(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v8M7.2 6.2a7.5 7.5 0 1 0 9.6 0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" />
        </svg>
        退出
      </button>
    </footer>
  );
}
