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
              failedPath={`/agent/tasks/${task.id}/steps`}
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
          <SecHead no="03" title="文件" count={files.length} right={<span className={styles.cap}>读过、写过、改过的文件</span>} />
          <FileImpact files={files} status={stepsStatus} onOpen={(path) => onAction?.({ kind: 'open_artifact', path })} />
        </section>
      )}
      {codeLive && (
        <section className={styles.sec}>
          <SecHead no="01" title="记录" right={<span className={styles.cap}>{task.agent} │ 只显示最近几行</span>} />
          <pre className={styles.log} data-selectable="">
            {'› 读取 Sources/CompanionCore/HostLink.swift\n› 运行 swift test --filter HostLinkTests（42 通过，1 失败）\n› 修改 reconnect()：心跳超时从 1.5 s 放宽到 3 s\n› 待批准：修改 HostLink.swift、运行 swift test'}
          </pre>
          <div className={styles.send}>
            <input className={styles.input} placeholder="给这个会话补一句…" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="给编码会话发消息" />
            <Btn
              variant="ghost"
              disabled={msg.trim() === ''}
              disabledReason="先写要发的话"
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
            <Btn variant="text" icon="ext" disabled={!sessionId} disabledReason="没有找到会话" onClick={() => sessionId && onAction?.({ kind: 'jump_terminal', sessionId })}>
              跳到终端
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
                在对话轮次里看
              </Btn>
            </dd>
          </>
        )}
        {queued && (
          <>
            <dt>排队</dt>
            <dd>等前台任务结束后开始</dd>
          </>
        )}
        {task.status === 'interrupted' && (
          <>
            <dt>中断</dt>
            <dd>
              后台服务重启时中断（{task.ended_at != null ? formatClock(task.ended_at) : '—'}）。不会自动重跑。
            </dd>
          </>
        )}
      </dl>
    </>
  );
}
