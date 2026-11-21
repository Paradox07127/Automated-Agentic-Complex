import type { PipKind } from './copy';
import { useArrowHover } from './guideMotion';
import styles from './Bits.module.css';

/** State mark: shape + text (ok ink block, attention yellow block, offline dashed frame, failed yellow block with !). */
export function Pip({ kind, label }: { kind: PipKind; label: string }) {
  return (
    <span className={styles.pip} data-kind={kind}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {kind === 'ok' && <rect x="1" y="1" width="8" height="8" className={styles.ink} />}
        {kind === 'attention' && <rect x="1.5" y="1.5" width="7" height="7" className={styles.flag} />}
        {kind === 'offline' && <rect x="1.5" y="1.5" width="7" height="7" className={styles.dash} />}
        {kind === 'failed' && (
          <>
            <rect x="1" y="1" width="8" height="8" className={styles.flag} />
            <path d="M5 2.6v3.2M5 6.6v1" className={styles.bang} />
          </>
        )}
      </svg>
      <span className={styles.pipText}>{label}</span>
    </span>
  );
}

export function KvTag({ k, v }: { k: string; v: string }) {
  return (
    <span className={styles.kv}>
      <b aria-hidden="true">{k}</b>
      <span>{v}</span>
    </span>
  );
}

/** Media panel arrow: a ringed disc with the double chevron, 74 px hit area; the white disc lights on hover. */
export function MediaArrow({ side, label, disabled, edge, onClick }: { side: 'left' | 'right'; label: string; disabled: boolean; edge?: boolean; onClick: () => void }) {
  const hover = useArrowHover(disabled);
  return (
    <button type="button" {...hover} className={styles.arrow} data-side={side} data-edge={edge || undefined} data-g="arrows" aria-label={label} disabled={disabled} onClick={onClick}>
      <span className={`${styles.disc} pager-ring`} data-g="light" aria-hidden="true" />
      <span className={styles.glow} data-g="disc" aria-hidden="true" />
      <svg className={`${styles.chev} pager-chevron`} data-g="arrow" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <path d="M17 8.5 9 17l8 8.5M25 8.5 17 17l8 8.5" />
      </svg>
    </button>
  );
}

/** Highlight frame over the box of its positioned parent: what to grant next. */
export function GuideRing() {
  return <span className={`${styles.ring} guide-ring`} aria-hidden="true" data-guide-ring="" />;
}

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
