import { Fragment } from 'react';
import { stateVisual, type Delivery } from '../../domain';
import styles from './VersionChain.module.css';

/** 版本链：`v1 ✕ ─ v2 ◆`；退回的版本悬停显示补充要求；给了 onPick 才是按钮。 */
export interface VersionChainProps {
  /** 同一任务的交付，任意顺序 */
  deliveries: Delivery[];
  /** 点某一版 */
  onPick?: (id: string) => void;
  /** 当前显示的那一版 */
  selected?: string;
}

const GLYPH: Record<Delivery['state'], string> = { accepted: '✓', rejected: '✕', produced: '◆', presented: '◆', viewed: '◆' };

export function VersionChain({ deliveries, onPick, selected }: VersionChainProps) {
  const vs = [...deliveries].sort((a, b) => a.version - b.version);
  return (
    <span data-stub="VersionChain" className={styles.root} role="list" aria-label="版本链">
      {vs.map((d, i) => {
        const label = d.state === 'accepted' || d.state === 'rejected' ? stateVisual(d.state).label : '待决定';
        const tip = `v${d.version} │ ${label}`;
        const body = (
          <>
            <span className="num">v{d.version}</span>
            <b aria-hidden="true">{GLYPH[d.state]}</b>
          </>
        );
        return (
          <Fragment key={d.id}>
            {i > 0 && <i className={styles.link} aria-hidden="true" />}
            {onPick ? (
              <span role="listitem">
                <button type="button" className={styles.node} data-state={d.state} title={tip} aria-label={tip} aria-pressed={d.id === selected} onClick={() => onPick(d.id)}>
                  {body}
                </button>
              </span>
            ) : (
              <span role="listitem" className={styles.node} data-state={d.state} title={tip} aria-label={tip}>
                {body}
              </span>
            )}
          </Fragment>
        );
      })}
    </span>
  );
}
