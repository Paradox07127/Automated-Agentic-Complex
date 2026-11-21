import { useState } from 'react';
import { Btn, Dialog } from '../../../ui';
import type { ChainOutcome } from './useChainEdit';
import styles from './MotionDetail.module.css';

export interface ChainEditBarProps {
  /** Edits in the proposal. */
  n: number;
  /** Why 检查 and 应用 are greyed out; null while they work. */
  block: string | null;
  busy: 'check' | 'apply' | null;
  outcome: ChainOutcome | null;
  /** In Chinese, the problems not shown beside a segment. */
  general: string[];
  onCheck: () => void;
  onApply: () => void;
  onDiscard: () => void;
}

/** 「编辑结构」's proposal: 检查, 应用到角色包（重建） behind a confirmation, 放弃改动, and what the last check or apply said. */
export function ChainEditBar(p: ChainEditBarProps) {
  const [asking, setAsking] = useState(false);
  const off = p.block != null || p.n === 0 || p.busy != null;
  const reason = p.block ?? (p.n === 0 ? '还没有改动' : undefined);
  const check = p.outcome && 'check' in p.outcome ? p.outcome.check : null;
  const changed = check?.graph_changes ? new Set(Object.values(check.graph_changes).flat()).size : 0;
  return (
    <div className={styles.editBar} data-chain-edit="">
      <div className={styles.acts}>
        <span className={styles.sub}>已改 {p.n} 处</span>
        <Btn size="sm" variant="secondary" loading={p.busy === 'check'} disabled={off} {...(reason ? { disabledReason: reason } : {})} onClick={p.onCheck}>
          检查
        </Btn>
        <Btn size="sm" variant="primary" loading={p.busy === 'apply'} disabled={off} {...(reason ? { disabledReason: reason } : {})} onClick={() => setAsking(true)}>
          应用到角色包（重建）
        </Btn>
        <Btn size="sm" variant="quiet" disabled={p.n === 0 || p.busy != null} onClick={p.onDiscard}>
          放弃改动
        </Btn>
        {p.block != null && (
          <span className={styles.sub} data-block="">
            {p.block}
          </span>
        )}
      </div>
      {check?.ok && <span className={styles.sub} data-check="ok">检查通过，会改动 {changed} 条链</span>}
      {p.outcome && 'failed' in p.outcome && (
        <span className={styles.why} role="alert">
          {p.outcome.failed}
        </span>
      )}
      {p.general.length > 0 && (
        <ul className={styles.problems} data-problems="">
          {p.general.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <Dialog
        open={asking}
        title="应用到角色包（重建）"
        onClose={() => setAsking(false)}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setAsking(false)}>
              取消
            </Btn>
            <Btn
              variant="primary"
              onClick={() => {
                setAsking(false);
                p.onApply();
              }}
            >
              重建
            </Btn>
          </>
        }
      >
        <p>会用这 {p.n} 处改动重建当前角色包，再用新包重新载入她。</p>
        <p>重建通常要一两分钟；这期间她会从桌面上消失，重新载入后回来，按改过的链播放。</p>
      </Dialog>
    </div>
  );
}
