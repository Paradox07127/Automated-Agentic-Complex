import type { ReactNode } from 'react';
import type { ActiveRun } from '../../domain';
import { RunRing } from '../../charts';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { Btn } from '../../ui';
import styles from './Chat.module.css';

export interface ChatBarProps {
  /** The character tabs, in the header after the title. */
  tabs: ReactNode;
  /** Show the run state and 停止: a topic is open. */
  status: boolean;
  /** agentd is busy with another conversation's run or line. */
  elsewhere: boolean;
  run: ActiveRun | null;
  canStop: boolean;
  doneSteps: number;
  totalSteps: number;
  onStop: () => void;
}

/** The page header: character tabs, and at the right the run state with 停止. */
export function ChatBar({ tabs, status, elsewhere, run, canStop, doneSteps, totalSteps, onStop }: ChatBarProps) {
  const cur = Math.min(totalSteps, doneSteps + 1);
  const right = status ? (
    <span className={styles.head}>
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
    </span>
  ) : undefined;
  return <PageHeaderSlot tabs={tabs} right={right} />;
}
