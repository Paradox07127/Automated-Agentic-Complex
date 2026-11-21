import { useState } from 'react';
import { formatClock, type EffectiveState } from '../../domain';
import { TasksLoadError } from '../../data/tasksBase';
import { Btn, Dialog, Region, Row, type RegionSource } from '../../ui';
import type { TaskDesk } from '../tasks/TaskDetailHost';
import type { Task } from '../../domain/work';

const PAGE_SIZE = 20;
const LABEL: Record<EffectiveState, string> = {
  waiting: '待处理', running: '进行中', idle: '空闲', done: '已完成', failed: '失败', stopped: '已停止',
};

const DAY = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

export function TaskRecords({ desk, onClose, onSelect }: { desk: TaskDesk; onClose: () => void; onSelect: (id: string) => void }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const tasks = (desk.view?.tasks ?? []).filter((task) => task.source !== 'ext').sort((a, b) => b.updated_at - a.updated_at);
  const error = desk.list.first.error;
  const q: RegionSource<Task[]> = {
    status: error ? 'error' : desk.listReady ? 'success' : 'pending',
    data: desk.listReady ? tasks : undefined,
    error: error instanceof TasksLoadError ? error.reason : error,
    isFetching: desk.list.first.isFetching,
    refetch: () => void desk.reload(),
  };
  return (
    <Dialog open title="任务记录" onClose={onClose}>
      <Region q={q} what="任务记录" reserve={{ rows: 3 }} empty={{ text: '还没有执行记录' }}>
        {(rows) => (
          <>
            {rows.slice(0, limit).map((task) => {
              const state = desk.view?.effective[task.id] ?? 'idle';
              const date = DAY.format(task.updated_at);
              return (
                <Row key={task.id} title={task.title || '未命名任务'} sub={`${task.source === 'role' ? '角色任务' : '编码任务'} │ ${date} ${formatClock(task.updated_at)}`}
                  right={LABEL[state]} attention={state === 'waiting'} data-task={task.id} onClick={() => onSelect(task.id)} />
              );
            })}
            {rows.length > limit && <Btn onClick={() => setLimit(limit + PAGE_SIZE)}>显示更多任务</Btn>}
          </>
        )}
      </Region>
    </Dialog>
  );
}
