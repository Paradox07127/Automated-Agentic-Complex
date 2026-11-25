import type { Task } from '../../domain';
import { Btn, Dialog } from '../../ui';

/** A stopped character ledger task continues from its checkpoint (http.py); a stopped job or run does not (jobs.py resume). */
export const canContinue = (t: Task): boolean => t.job_id == null && t.target === 'character' && t.task_id != null;

export type StopResume = 'all' | 'none' | 'some';

/** Whether the tasks being stopped can 继续 afterwards. */
export function resumeOf(tasks: readonly Task[]): StopResume {
  const n = tasks.filter(canContinue).length;
  return n === 0 ? 'none' : n === tasks.length ? 'all' : 'some';
}

const ENDED = new Set<Task['status']>(['succeeded', 'accepted', 'rejected', 'failed', 'denied', 'expired', 'cancelled']);

/** Why a job cancel answered cancelled:false: jobs.py settles only a queued, running, interrupted or waiting_user job. */
export function notStopped(t: Task): string {
  if (t.status === 'needs_review') return '当前任务待复核，无法停止';
  if (ENDED.has(t.status)) return '该任务已结束，无需停止';
  return '后台服务未能停止该任务：任务状态已变更，请刷新查看';
}

const AFTER: Record<StopResume, string> = {
  all: '已生成的产物会保留，后续可在任务详情中「继续」。',
  none: '已生成的产物会保留，停止后无法恢复执行。',
  some: '已生成的产物会保留；角色任务后续可「继续」，其余任务停止后无法恢复执行。',
};

/** 停止任务确认：全站一个动词、一个确认框；默认焦点在「不停止」；写明产物保留，以及之后能不能「继续」。 */
export interface StopConfirmProps {
  /** 是否打开 */
  open: boolean;
  /** 要停的任务标题；多选时传数量 */
  target: string | number;
  /** 停止后能否「继续」（resumeOf）；默认不能 */
  resume?: StopResume;
  /** 停止 */
  onConfirm?: () => void;
  /** 不停止 / esc */
  onCancel?: () => void;
}

export function StopConfirm({ open, target, resume = 'none', onConfirm, onCancel }: StopConfirmProps) {
  const title = typeof target === 'number' ? `停止选中的 ${target} 个任务？` : `停止「${target}」？`;
  return (
    <div data-stub="StopConfirm" hidden={!open}>
      <Dialog
        open={open}
        title={title}
        onClose={onCancel}
        footer={
          <>
            <Btn variant="secondary" kbd="esc" onClick={onCancel}>
              不停止
            </Btn>
            <Btn variant="danger" onClick={onConfirm}>
              停止任务
            </Btn>
          </>
        }
      >
        <p>{`正在执行的步骤会被中断。${AFTER[resume]}外部会话不受影响。`}</p>
      </Dialog>
    </div>
  );
}

export const StopConfirmDemos: Array<{ name: string; props: StopConfirmProps }> = [
  { name: 'single', props: { open: true, target: '汇总 10 月开销表' } },
  { name: 'many', props: { open: true, target: 2 } },
];
