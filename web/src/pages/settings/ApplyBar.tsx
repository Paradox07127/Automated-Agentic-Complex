import { useSettings } from './ctx';
import { Cap, St } from './kit';
import { labelOf } from './registry';
import styles from './ApplyBar.module.css';

/**
 * The bottom bar (BottomNode): the tip at the left, capsules at the right. Drafts「未应用 N 项 [撤销] [应用]」; saved changes that wait for a
 * backend restart; the backend gone; else how changes take effect.
 */
export function ApplyBar() {
  const { model, ro, agentdOff } = useSettings();
  const drafts = Object.keys(model.draft).length;
  const pending = Object.keys(model.pending);
  const waits = drafts > 0 || pending.length > 0;
  return (
    // A footer inside the page is no landmark of its own; the region keeps the bar named for screen readers.
    <footer role="region" className={styles.bar} aria-label={waits ? '未应用的改动' : '改动怎么生效'} data-g="foot">
      {pending.length > 0 && (
        <div className={styles.line}>
          <span className={styles.tip}>
            <St tone="warn" />
            <span className="num">{pending.length}</span> 项重启后台服务后生效：{pending.map(labelOf).join('、')}
          </span>
          <Cap lg tone={drafts ? undefined : 'acc'} loading={model.restarting} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void model.restartBackend()}>
            立即重启后台
          </Cap>
        </div>
      )}
      {drafts > 0 && (
        <div className={styles.line}>
          <span className={styles.tip}>
            <St tone="warn" />
            未应用 <span className="num">{drafts}</span> 项 │ 要一起生效，点「应用」后保存
          </span>
          <Cap lg onClick={model.revertAll}>
            撤销
          </Cap>
          <Cap lg tone="acc" disabled={ro || agentdOff} disabledReason="后台服务没有运行" onClick={() => void model.applyAll()}>
            应用
          </Cap>
        </div>
      )}
      {!waits && agentdOff && (
        <div className={styles.line}>
          <span className={styles.tip}>
            <St tone="bad">后台已断开</St> 内核、账号暂时只读
          </span>
          <Cap lg loading={model.restarting} onClick={() => void model.restartBackend()}>
            重启后台服务
          </Cap>
        </div>
      )}
      {!waits && !agentdOff && (
        <div className={styles.line}>
          <span className={styles.tip}>改动立即生效 │ 每次改动后几秒内可在提示里撤销</span>
        </div>
      )}
    </footer>
  );
}
