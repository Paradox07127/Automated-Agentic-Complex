import { useState } from 'react';
import { formatClock, type Delivery } from '../../domain';
import { VersionChain } from '../../features/delivery';
import { SecHead } from '../../ui';
import type { NativeOff } from './actions';
import { ArtifactTable } from './ArtifactTable';
import styles from './TaskView.module.css';

export interface DeliverySectionProps {
  deliveries: Delivery[];
  /** The opened count already shows in the 等你决定 bar. */
  countInBar: boolean;
  canReveal?: boolean;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  nativeOff?: NativeOff;
}

const STEPS = ['产出', '送达', '看过', '决定'] as const;

/** One line: 产出 14:26 → 送达 14:27 → 看过 14:30 → 等你; the decision step names the verdict. */
function chainText(d: Delivery): string {
  const ts = [d.produced_at, d.presented_at, d.viewed_at, d.decided_at];
  const verdict = d.state === 'accepted' ? '已接受' : d.state === 'rejected' ? '已退回' : STEPS[3];
  const firstOpen = ts.findIndex((t) => t == null);
  return STEPS.map((s, i) => {
    const t = ts[i];
    const name = i === 3 ? verdict : s;
    if (t != null) return `${name} ${formatClock(t)}`;
    return i === firstOpen ? `${name} 待处理` : `${name} —`;
  }).join(' → ');
}

/** 产物 table with the version chain and the delivery timeline folded into one line. */
export function DeliverySection({ deliveries, countInBar, canReveal, onOpen, onReveal, onCopyPath, nativeOff }: DeliverySectionProps) {
  const sorted = [...deliveries].sort((a, b) => a.version - b.version);
  const [shown, setShown] = useState<string | null>(null);
  const d = sorted.find((x) => x.id === shown) ?? sorted.at(-1);
  if (!d) return null;
  // The 等你决定 bar already names the verification of the version under review.
  const verify = countInBar && d === sorted.at(-1) ? '' : ` │ ${d.verification_source === 'auto' ? '已自动检查' : '未验证'}`;
  const hasArtifacts = d.artifacts.length > 0;
  const title = hasArtifacts ? '产物' : '交付';
  return (
    <section className={styles.sec} aria-label={title}>
      <SecHead title={title} count={hasArtifacts && !countInBar && !d.redacted ? d.artifacts.length : undefined} />
      <p className={styles.chain}>
        {sorted.length > 1 && <VersionChain deliveries={sorted} selected={d.id} onPick={setShown} />}
        <span className="num">
          {chainText(d)}
          {verify}
        </span>
      </p>
      {d.redacted ? (
        <p className={styles.note} role="status">
          这一版已撤回：标题、摘要和产物都不再显示
        </p>
      ) : hasArtifacts && (
        <ArtifactTable artifacts={d.artifacts} canReveal={canReveal} onOpen={onOpen} onReveal={onReveal} onCopyPath={onCopyPath} nativeOff={nativeOff} />
      )}
    </section>
  );
}
