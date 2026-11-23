import { BottomBar } from '../../shell/BottomBar';
import { BottomBarSlot } from '../../shell/headerSlot';
import { Btn } from '../../ui';
import { StatusLamp } from '../../ui/game';
import { useSettings } from './ctx';
import { labelOf } from './registry';
import { serviceOf } from './servicesDraft';
import styles from './ApplyBar.module.css';

/**
 * The page's line in the shell's bottom bar: drafts「未应用 N 项 [撤销] [应用]」; saved changes that wait for a backend restart;
 * the backend gone; else how changes take effect.
 */
export function ApplyBar() {
  const { model, ro, agentdOff } = useSettings();
  const drafts = Object.keys(model.draft).length;
  // The service cards save through the shell, which runs without agentd.
  const needsAgentd = Object.keys(model.draft).some((id) => !serviceOf(id));
  const pending = Object.keys(model.pending);
  const waits = drafts > 0 || pending.length > 0;
  const status = (
    <>
      {pending.length > 0 && (
        <span className={styles.tip}>
          <StatusLamp state="waiting" size="sm" label="" />
          <span className="num">{pending.length}</span> 项重启后台服务后生效：{pending.map(labelOf).join('、')}
        </span>
      )}
      {drafts > 0 && (
        <span className={styles.tip}>
          <StatusLamp state="waiting" size="sm" label="" />
          未应用 <span className="num">{drafts}</span> 项 │ 要一起生效，点「应用」后保存
        </span>
      )}
      {!waits && agentdOff && (
        <span className={styles.tip}>
          <StatusLamp state="broken" size="sm" label="后台已断开" /> AI 设置暂时只读
        </span>
      )}
      {!waits && !agentdOff && '改动立即生效 │ 每次改动后几秒内可在提示里撤销'}
    </>
  );
  const actions =
    waits || agentdOff ? (
      <>
        {pending.length > 0 && (
          <Btn size="sm" variant={drafts ? 'ghost' : 'primary'} loading={model.restarting} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void model.restartBackend()}>
            立即重启后台
          </Btn>
        )}
        {drafts > 0 && (
          <>
            <Btn size="sm" onClick={model.revertAll}>
              撤销
            </Btn>
            <Btn size="sm" variant="primary" disabled={ro || (agentdOff && needsAgentd)} disabledReason="后台服务没有运行" onClick={() => void model.applyAll()}>
              应用
            </Btn>
          </>
        )}
        {!waits && (
          <Btn size="sm" loading={model.restarting} onClick={() => void model.restartBackend()}>
            重启后台服务
          </Btn>
        )}
      </>
    ) : undefined;
  return (
    <BottomBarSlot>
      {/* The shell's bar is no landmark of its own; the region keeps this line named for screen readers. */}
      <div role="region" className={styles.bar} aria-label={waits ? '未应用的改动' : '改动怎么生效'}>
        <BottomBar status={status} actions={actions} />
      </div>
    </BottomBarSlot>
  );
}
