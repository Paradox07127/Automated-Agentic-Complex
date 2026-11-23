// The bottom bar: 派发任务 / 新建定时任务 over the list, one line saying what the right-hand button does, then the actions
// for the selection (or 取消 / 派出去 · 保存 while editing).
import type { ReactNode } from 'react';
import { keyText } from '../../bridge/platformText';
import type { Task } from '../../domain';
import type { Schedule } from '../../domain/schedules';
import { canContinue } from '../../features/task';
import { Btn, IconBtn, InfoTip } from '../../ui';
import type { EditDraft } from './draft';
import { stoppable } from './model';
import type { TasksTab } from './params';
import type { TaskDesk } from './useTaskDesk';
import styles from './Bar.module.css';

export function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Btn variant="ghost" icon="plus" kbd={keyText('⌘N')} onClick={onClick}>
      {label}
    </Btn>
  );
}

export interface BottomBarProps {
  tab: TasksTab;
  empty: boolean;
  newLabel: string;
  onNew: () => void;
  draft: EditDraft | null;
  problem: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  task: Task | null;
  desk: TaskDesk;
  dev: boolean;
  schedule: Schedule | null;
  onNote: () => void;
  onAgain: () => void;
  onGoChat: (conversationId: string) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}

export function BottomBar(p: BottomBarProps) {
  const { task, desk, schedule } = p;
  let tip = '';
  let right: ReactNode = null;
  if (p.draft) {
    const repeat = p.draft.when === 'repeat';
    tip = repeat ? '保存后在「定时」里' : '派出去后在「进行中」里';
    right = (
      <>
        <Btn variant="secondary" kbd="esc" onClick={p.onCancel}>
          取消
        </Btn>
        <Btn variant="primary" kbd={keyText('⌘↵')} loading={p.busy} disabled={p.problem != null} disabledReason={p.problem ?? undefined} onClick={p.onSubmit}>
          {p.draft.scheduleId ? '保存' : repeat ? '保存定时' : '派出去'}
        </Btn>
      </>
    );
  } else if (task && desk.view && desk.actions) {
    const act = desk.actions.onTask(task);
    const ended = ['done', 'failed', 'stopped'].includes(desk.view.effective[task.id] ?? '');
    const session = desk.view.sessions.find((s) => s.task_id === task.id) ?? null;
    const chat = task.conversation_id ? <IconBtn icon="send" label="在对话中打开" onClick={() => p.onGoChat(task.conversation_id!)} /> : null;
    const term =
      task.source === 'code' && session ? (
        <Btn variant="ghost" icon="ext" disabled={!!desk.nativeOff.jump} disabledReason={desk.nativeOff.jump} onClick={() => act({ kind: 'jump_terminal', sessionId: session.id })}>
          跳到终端
        </Btn>
      ) : null;
    const trace = p.dev ? (
      <Btn variant="ghost" icon="history" onClick={() => act({ kind: 'open_timeline' })}>
        运行记录
      </Btn>
    ) : null;
    const stopped = task.status === 'cancelled' || desk.local.stopped[task.id] != null;
    if (ended) {
      tip = '再派一次：同样的标题新派一个任务';
      const more = task.source === 'role' && !stopped && ['failed', 'rejected', 'interrupted'].includes(task.status) || (stopped && canContinue(task));
      right = (
        <>
          {chat}
          {term}
          {trace}
          {more && (
            <Btn variant="ghost" onClick={p.onNote}>
              补一句接着做
            </Btn>
          )}
          <Btn variant="ghost" tail="refresh" onClick={p.onAgain}>
            再派一次
          </Btn>
        </>
      );
    } else {
      const live = stoppable(task) && !stopped;
      right = (
        <>
          {chat}
          {term}
          {trace}
          {task.source === 'role' && task.status === 'running' && (
            <Btn variant="ghost" onClick={p.onNote}>
              补一句…
            </Btn>
          )}
          {live && (
            <>
              <InfoTip label="停止后会怎样">停止后已写的文件留着，不能接着做</InfoTip>
              <Btn variant="secondary" tail="close" onClick={() => act({ kind: 'stop' })}>
                停止任务
              </Btn>
            </>
          )}
        </>
      );
    }
  } else if (schedule) {
    tip = '删除会连同它的运行记录一起删';
    right = (
      <>
        <IconBtn icon="del" label="删除定时任务" onClick={p.onDelete} />
        <Btn variant="ghost" icon="tune" onClick={p.onEdit}>
          编辑
        </Btn>
        <Btn variant="ghost" tail="play" disabled={!!schedule.last_error} disabledReason="先重新选资料" onClick={p.onRunNow}>
          立即运行
        </Btn>
      </>
    );
  }
  return (
    <div className={styles.bot} data-tasks-bar="">
      <span className={styles.left}>{!p.draft && !p.empty && <NewButton label={p.newLabel} onClick={p.onNew} />}</span>
      <span className={styles.tip}>{tip}</span>
      <span className={styles.right}>{right}</span>
    </div>
  );
}
