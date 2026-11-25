import { useState } from 'react';
import { formatClock } from '../../domain';
import { Btn, SecHead } from '../../ui';
import { Fold } from '../../ui/Fold';
import { FileImpact } from './FileImpact';
import { RunWaterfall } from './RunWaterfall';
import type { TaskDetailProps } from './TaskDetail';
import { ToolDist } from './ToolDist';
import styles from './TaskSections.module.css';

/** Detail body under the delivery box: 01 steps, 02 tools, 03 files, session log, meta rows. */
export function TaskSections({ task, now, deliveries = [], steps = [], tools = [], files = [], stepsStatus = 'ok', sessionId = null, toolFocus = null, stoppedAt = null, onAction }: TaskDetailProps) {
  const [tool, setTool] = useState<string | null>(toolFocus);
  const [gen, setGen] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const queued = task.status === 'queued';
  const waterfall = task.source === 'role' || queued;
  const codeLive = task.source === 'code' && task.status === 'running' && stoppedAt == null;
  return (
    <>
      {waterfall && (
        <section className={styles.sec}>
          <Fold variant="head" label="步骤" count={task.steps.length || undefined} defaultOpen head={{ no: '01' }}>
            <RunWaterfall
              steps={steps}
              tools={tools}
              deliveries={deliveries}
              now={now}
              status={stepsStatus}
              queued={queued}
              highlightTool={tool}
              generation={gen}
              onGeneration={setGen}
              onRetry={() => onAction?.({ kind: 'retry_steps' })}
            />
          </Fold>
        </section>
      )}
      {waterfall && !queued && (
        <section className={styles.sec}>
          <Fold variant="head" label="工具" count={tools.length} defaultOpen={toolFocus != null} head={{ no: '02' }}>
            <ToolDist tools={tools} now={now} selected={tool} onPick={setTool} />
          </Fold>
        </section>
      )}
      {task.source === 'role' && !queued && (
        <section className={styles.sec}>
          <SecHead no="03" title="文件" count={files.length} right={<span className={styles.cap}>读取、写入或修改过的文件</span>} />
          <FileImpact files={files} status={stepsStatus} onOpen={(path) => onAction?.({ kind: 'open_artifact', path })} />
        </section>
      )}
      {codeLive && (
        <section className={styles.sec}>
          <SecHead no="01" title="会话控制" right={<span className={styles.cap}>{task.agent} │ 实时输出请在终端查看</span>} />
          <div className={styles.send}>
            <input className={styles.input} placeholder="向当前编码会话发送补充指令…" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="向编码会话发送指令" />
            <Btn
              variant="ghost"
              disabled={msg.trim() === ''}
              disabledReason="请先输入要发送的内容"
              onClick={() => {
                onAction?.({ kind: 'send_session', text: msg.trim() });
                setMsg('');
              }}
            >
              发送
            </Btn>
            <Btn variant="ghost" icon="stop" onClick={() => onAction?.({ kind: 'stop' })}>
              停止任务
            </Btn>
            <Btn variant="text" icon="ext" disabled={!sessionId} disabledReason="未找到关联会话" onClick={() => sessionId && onAction?.({ kind: 'jump_terminal', sessionId })}>
              跳转至终端
            </Btn>
          </div>
        </section>
      )}
      <dl className={styles.dl}>
        {task.cwd && (
          <>
            <dt>目录</dt>
            <dd className={styles.mono}>{task.cwd}</dd>
          </>
        )}
        {task.run_count > 0 && task.source !== 'ext' && (
          <>
            <dt>运行</dt>
            <dd>
              <span className="num">{task.run_count}</span> 次{' '}
              <Btn size="sm" variant="text" icon="ext" onClick={() => onAction?.({ kind: 'open_timeline' })}>
                查看对话轮次
              </Btn>
            </dd>
          </>
        )}
        {queued && (
          <>
            <dt>排队</dt>
            <dd>等待前台任务完成后开始</dd>
          </>
        )}
        {task.status === 'interrupted' && (
          <>
            <dt>中断</dt>
            <dd>
              任务已中断（{task.ended_at != null ? formatClock(task.ended_at) : '—'}），不会自动重新运行。
            </dd>
          </>
        )}
      </dl>
    </>
  );
}
