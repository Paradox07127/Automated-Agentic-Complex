import { Btn } from '../../ui';
import { useSettings } from './ctx';
import styles from './ApplyBar.module.css';

/** Bottom bar, only while something waits: the tip at the left, capsules at the right. Drafts「未应用 N 项 [撤销] [应用]」, where 撤销 is the white Reset capsule and 应用 the save; saved changes that need a backend restart. */
export function ApplyBar() {
  const { model, ro, agentdOff } = useSettings();
  const drafts = Object.keys(model.draft).length;
  const pending = Object.keys(model.pending).length;
  if (drafts === 0 && pending === 0) return null;
  return (
    <>
      <div className={styles.fill} aria-hidden="true" />
      <section className={styles.bar} aria-label="未应用的改动">
        {pending > 0 && (
          <div className={styles.line}>
            <span className={styles.tip}>
              <span className="num">{pending}</span> 项重启后台服务后生效
            </span>
            <Btn size="lg" variant="ghost" loading={model.restarting} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void model.restartBackend()}>
              立即重启
            </Btn>
          </div>
        )}
        {drafts > 0 && (
          <div className={styles.line}>
            <span className={styles.tip}>
              未应用 <span className="num">{drafts}</span> 项
            </span>
            <Btn size="lg" variant="ghost" onClick={model.revertAll}>
              撤销
            </Btn>
            <Btn size="lg" variant="primary" disabled={ro || agentdOff} disabledReason="后台服务没有运行" onClick={() => void model.applyAll()}>
              应用
            </Btn>
          </div>
        )}
      </section>
    </>
  );
}
