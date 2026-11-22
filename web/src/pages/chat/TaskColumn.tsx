import type { ComponentProps } from 'react';
import { getBridge } from '../../bridge';
import { TaskDrawer } from '../../features/task';
import { navigate } from '../../shell/nav';
import { Btn } from '../../ui';
import type { TasksView } from '../tasks/model';
import { RightPanel } from './RightPanel';
import { RunItems } from './RunItems';

type Drawer = ComponentProps<typeof TaskDrawer>;

/** The task column: the task's drawer and its run's items. */
export function TaskColumn({ view, demo, livePlan, onClose, ...p }: Pick<Drawer, 'task' | 'now' | 'delivery' | 'deliveries' | 'activeRun' | 'kernelName' | 'busy' | 'onAction' | 'onReceipt'> & { view: TasksView; demo: string | null; livePlan: boolean; onClose: () => void }) {
  const { task } = p;
  return (
    <RightPanel onClose={onClose}>
      <TaskDrawer
        key={`${task.id}-${demo ?? ''}`}
        {...p}
        effective={view.effective[task.id] ?? 'running'}
        pending={view.pending.filter((x) => x.task_id === task.id)}
        planSource={livePlan ? 'live' : 'snapshot'}
        rejecting={demo === 'reject'}
        canReveal={getBridge().capabilities.revealInFinder}
        onOpenTask={() => navigate({ page: 'overview', sel: task.id })}
      />
      {task.run_id && (
        <>
          <RunItems key={task.run_id} runId={task.run_id} running={p.activeRun != null} />
          <Btn size="sm" variant="text" onClick={() => task.run_id && navigate({ page: 'trace', turn: task.run_id })}>完整运行记录 ↗</Btn>
        </>
      )}
    </RightPanel>
  );
}
