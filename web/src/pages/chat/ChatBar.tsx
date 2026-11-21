import type { ActiveRun } from '../../domain';
import { RunRing } from '../../charts';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { Btn, Menu, type MenuItem } from '../../ui';
import styles from './Chat.module.css';

export interface ChatBarProps {
  /** Conversation title, the header's second crumb. */
  title: string | null;
  /** History or archived conversation: no run state, no 停止. */
  history: boolean;
  archived: boolean;
  /** agentd is busy with another conversation's run or line. */
  elsewhere: boolean;
  run: ActiveRun | null;
  canStop: boolean;
  doneSteps: number;
  totalSteps: number;
  manage: MenuItem[] | null;
  onHistory: () => void;
  onStop: () => void;
}

/** Conversation status, history and management. */
export function ChatBar({ title, history, archived, elsewhere, run, canStop, doneSteps, totalSteps, manage, onHistory, onStop }: ChatBarProps) {
  if (!title) return <PageHeaderSlot />;
  const cur = Math.min(totalSteps, doneSteps + 1);
  const right = (
    <span className={styles.head}>
      {history ? (
        <span className={styles.idle}>{archived ? '已归档对话' : '历史对话'}</span>
      ) : (
        <>
          <span className={styles.run}>
            <RunRing state={run?.state ?? (canStop ? 'running' : 'idle')} phase={run?.phase ?? undefined} />
            {canStop ? (
              <span>
                执行中
                {totalSteps > 0 && (
                  <>
                    {' │ 第 '}
                    <b className="num">{cur}</b>
                    <small className="num">/{totalSteps}</small> 步
                  </>
                )}
              </span>
            ) : (
              <span className={styles.idle}>{elsewhere ? '角色在其他对话中执行' : '空闲'}</span>
            )}
          </span>
          <Btn size="sm" variant="ghost" icon="stop" disabled={!canStop} disabledReason="没有执行中的任务" onClick={onStop}>
            停止
          </Btn>
        </>
      )}
      <Btn size="sm" variant="ghost" onClick={onHistory}>历史记录</Btn>
      {manage && <Menu label="管理对话" icon="more" align="right" items={manage} />}
    </span>
  );
  return <PageHeaderSlot {...(title ? { sub: title } : {})} right={right} />;
}
