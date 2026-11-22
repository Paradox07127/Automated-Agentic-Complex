import { useState } from 'react';
import { Btn, Dialog } from '../../../ui';
import type { ChainOutcome } from './useChainEdit';
import styles from './Edit.module.css';

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

/** 结构提案带（橙色斜纹，提交条上方）：检查、应用到角色包（重建）先确认、放弃改动，和上次检查或应用的结果。 */
export function ChainEditBar(p: ChainEditBarProps) {
  const [asking, setAsking] = useState(false);
  const off = p.block != null || p.n === 0 || p.busy != null;
  const reason = p.block ?? (p.n === 0 ? '还没有改动' : undefined);
  const check = p.outcome && 'check' in p.outcome ? p.outcome.check : null;
  const changed = check?.graph_changes ? new Set(Object.values(check.graph_changes).flat()).size : 0;
  return (
    <div className={styles.prop} data-chain-edit="" role="group" aria-label="结构提案">
      <div className={styles.pr}>
        <b>结构提案 │ {p.n} 处</b>
        <span className={styles.note}>应用会重建角色包，一两分钟内她会离开桌面</span>
        <span className={styles.sp} />
        <button type="button" className={styles.mini} disabled={off} title={reason} onClick={p.onCheck}>
          {p.busy === 'check' ? '检查中' : '检查'}
        </button>
        <button type="button" className={styles.mini} data-or="" disabled={off} title={reason} onClick={() => setAsking(true)}>
          {p.busy === 'apply' ? '重建中' : '应用到角色包（重建）'}
        </button>
        <button type="button" className={styles.mini} data-q="" disabled={p.n === 0 || p.busy != null} onClick={p.onDiscard}>
          放弃改动
        </button>
      </div>
      {p.block != null && (
        <span className={styles.sub} data-block="">
          {p.block}
        </span>
      )}
      {check?.ok && (
        <span className={styles.sub} data-check="ok">
          检查通过，会改动 {changed} 条链
        </span>
      )}
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
