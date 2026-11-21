import { useState } from 'react';
import type { Delivery } from '../../domain';
import { Icon } from '../../ui';
import { ArtifactList } from './ArtifactList';
import { DeliveryChain } from './DeliveryChain';
import { VersionChain } from './VersionChain';
import styles from './DeliveryBox.module.css';

/** 交付框：「交付 v2」、版本链（点某一版切到那一版）和交付轨同一行、产物表；待复核态右端黄渐变 + 对勾水印。 */
export interface DeliveryBoxProps {
  /** 同一任务的全部交付；显示最新一版 */
  deliveries: Delivery[];
  /** 当前时间 */
  now: number;
  /** 桥有 revealInFinder 能力位 */
  canReveal?: boolean;
  /** 打开产物 */
  onOpen?: (path: string) => void;
  /** 在 Finder 中显示 */
  onReveal?: (path: string) => void;
  /** 复制路径 */
  onCopyPath?: (path: string) => void;
  /** 同屏已有其他主操作：不加黄渐变和对勾水印 */
  secondaryEmphasis?: boolean;
}

/** Header tag: undecided versions all read "已送达 · 待决定" so it never contradicts "产物 0/2 打开过". */
function stateText(d: Delivery): string {
  if (d.state === 'accepted') return '已接受';
  if (d.state === 'rejected') return '已退回';
  return d.state === 'produced' ? '已产出 │ 待决定' : '已送达 │ 待决定';
}

export function DeliveryBox({ deliveries, now, canReveal, onOpen, onReveal, onCopyPath, secondaryEmphasis }: DeliveryBoxProps) {
  const [shown, setShown] = useState<string | null>(null);
  const sorted = [...deliveries].sort((a, b) => a.version - b.version);
  const at = sorted.findIndex((x) => x.id === shown);
  const i = at >= 0 ? at : sorted.length - 1;
  const d = sorted[i];
  if (!d) return null;
  const prev = sorted[i - 1];
  const reviewing = d.decided_at == null;
  return (
    <section data-stub="DeliveryBox" className={styles.box} data-review={reviewing || undefined} data-quiet={secondaryEmphasis || undefined} aria-label={`交付 v${d.version}`}>
      <span className={styles.wm} aria-hidden="true">
        <Icon name="file" size={32} />
      </span>
      {reviewing && !secondaryEmphasis && (
        <span className={styles.ok} aria-hidden="true">
          <Icon name="check" size={32} />
        </span>
      )}
      <div className={styles.inner}>
        <header className={styles.head}>
          <div className={styles.title}>
            <span className={styles.code}>交付 v{d.version}</span>
            <span className={styles.tag} data-state={d.state}>
              {stateText(d)}
            </span>
          </div>
          <div className={styles.chains}>
            {sorted.length > 1 && <VersionChain deliveries={sorted} selected={d.id} onPick={setShown} />}
            <DeliveryChain delivery={d} now={now} />
          </div>
        </header>
        {d.redacted ? (
          <p className={styles.prev}>这一版已撤回，内容不再显示</p>
        ) : (
          <ArtifactList artifacts={d.artifacts} canReveal={canReveal} onOpen={onOpen} onReveal={onReveal} onCopyPath={onCopyPath} />
        )}
        {prev && (
          <p className={styles.prev}>
            v{prev.version} │ {stateText(prev)}
          </p>
        )}
      </div>
    </section>
  );
}
