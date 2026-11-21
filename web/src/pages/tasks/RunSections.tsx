import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BarList } from '../../charts';
import { formatClock, formatMs, type FileEffect } from '../../domain';
import { verifyText } from '../../domain/errorText';
import { RawFold } from '../../features/trace';
import { RunWaterfall, toolRows, type TaskDetailProps } from '../../features/task';
import { Btn, KV, SecHead, Table, TableCell, TableHead, TableRow, type KVItem } from '../../ui';
import { RunItems } from '../chat/RunItems';
import type { NativeOff } from './actions';
import { failureSummary, runOutput } from './runText';
import type { RunOutcome } from './useTasksData';
import styles from './TaskView.module.css';

const OP: Record<FileEffect['op'], string> = { read: '读', write: '写', modify: '改' };

/** What the page reads beside the task row: run results, the coding session's lines, the steps' next page. */
export interface RunExtras {
  runs?: RunOutcome[];
  /** Own coding session transcript; null while it loads or when there is none. */
  sessionLines?: string[] | null;
  /** The transcript read failed. */
  linesFailed?: boolean;
  onRetryLines?: () => void;
  /** Native entries the shell refused, with the reason. */
  nativeOff?: NativeOff;
  moreSteps?: boolean;
  onMoreSteps?: () => void;
}

function Fold({ title, count, open: start, right, children }: { title: string; count?: number; open: boolean; right?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <section className={styles.sec} aria-label={title}>
      <SecHead title={title} count={count} right={right} collapsed={!open} onToggle={() => setOpen(!open)} />
      {open && children}
    </section>
  );
}

/** Detail body under the decision bar: failure or steps (waterfall + folded output), tools, files, live session, meta. */
export function RunSections({ task, now, deliveries = [], steps = [], tools = [], files = [], stepsStatus = 'ok', activeRun = null, sessionId = null, toolFocus = null, stoppedAt = null, onAction, runs = [], sessionLines = null, linesFailed = false, onRetryLines, nativeOff = {}, moreSteps = false, onMoreSteps }: TaskDetailProps & RunExtras) {
  const [tool, setTool] = useState<string | null>(toolFocus);
  const [gen, setGen] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const toolsRef = useRef<HTMLDivElement>(null);
  const queued = task.status === 'queued';
  const waterfall = task.source === 'role' || queued;
  const codeLive = task.source === 'code' && task.status === 'running' && stoppedAt == null;
  const runId = runs.find((r) => r.generation === gen)?.run_id ?? activeRun?.run_id ?? task.run_id ?? steps.at(-1)?.run_id ?? null;
  const raw = steps.length > 0 ? runOutput(steps, tools) : undefined;
  const checks = runs.at(-1)?.checks ?? null;
  const lines = sessionLines ?? [];
  // An interrupted row says so in the meta lines, a cancelled one in its status; a reason alone of a task waiting for 验收 is in its decision bar.
  // no_verify_cmd stays in result after 验收 or 退回, and the status already says which.
  const v = task.verify ?? null;
  const verify = !v || task.status === 'interrupted' || task.status === 'cancelled' || v.reason === 'no_verify_cmd' || (task.status === 'needs_review' && v.exit_code == null && !v.output_tail) ? null : v;
  const chart = (
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
  );
  const more = moreSteps && onMoreSteps && (
    <Btn size="sm" variant="quiet" onClick={onMoreSteps}>
      更多步骤
    </Btn>
  );

  // Tools arrive after the first render; scroll once the section exists.
  const hasTools = tools.length > 0 || (task.source === 'role' && runId != null);
  useEffect(() => {
    if (toolFocus && hasTools) toolsRef.current?.scrollIntoView({ block: 'start' });
  }, [toolFocus, hasTools]);

  const meta: KVItem[] = [
    ...(task.cwd ? [{ key: '目录', value: task.cwd, mono: true }] : []),
    ...(task.character_id ? [{ key: '角色', value: task.character_id, mono: true }] : []),
    ...(checks ? [{ key: '检查', value: <span className="num">{`${checks.passed}/${checks.total} 通过`}</span> }] : []),
    ...(task.run_count > 0 && task.source !== 'ext'
      ? [
          {
            key: '运行',
            value: (
              <span className={styles.inline}>
                {!waterfall && (
                  <span>
                    <span className="num">{task.run_count}</span> 次
                  </span>
                )}
                <Btn size="sm" variant="ghost" icon="ext" disabled={!runId} disabledReason="没有关联的运行" onClick={() => runId && onAction?.({ kind: 'open_timeline', runId })}>
                  在诊断中看
                </Btn>
              </span>
            ),
          },
        ]
      : []),
    ...(queued ? [{ key: '排队', value: '等前台任务结束后开始' }] : []),
    ...(task.status === 'interrupted'
      ? [
          {
            key: '中断',
            value: (
              <span className="num">后台重启时中断 │ {task.ended_at != null ? formatClock(task.ended_at) : '—'}</span>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      {task.failure ? (
        <section className={styles.sec} aria-label="失败">
          <div className={styles.fold}>
            <RawFold summary={failureSummary(task.failure.reason, steps, task.steps.find((s) => s.status === 'failed')?.text ?? null)} raw={raw} rawLabel="运行输出">
              {waterfall ? chart : undefined}
            </RawFold>
            {more}
          </div>
        </section>
      ) : (
        waterfall && (
          <Fold title="步骤" count={task.steps.length || undefined} open>
            <div className={styles.fold}>
              <RawFold summary={[]} raw={raw} rawLabel="运行输出">
                {chart}
              </RawFold>
              {more}
            </div>
          </Fold>
        )
      )}
      {waterfall && !queued && hasTools && (
        <div ref={toolsRef} data-nav-target="task-tools">
          <Fold key={toolFocus ?? 'tools'} title="工具" count={tools.length || undefined} open={toolFocus != null}>
            {tools.length > 0 && <BarList rows={toolRows(tools, now)} label="工具耗时" top={6} otherReadout={formatMs} selected={tool} onPick={(k) => setTool(k === tool ? null : k)} />}
            {runId && <RunItems key={runId} runId={runId} running={activeRun?.run_id === runId} />}
          </Fold>
        </div>
      )}
      {task.source === 'role' && !queued && files.length > 0 && (
        <Fold title="文件" count={files.length} open={false}>
          <Table
            label="读写过的文件"
            head={
              <TableHead>
                <TableCell head>文件</TableCell>
                <TableCell head>操作</TableCell>
                <TableCell head num>
                  增删
                </TableCell>
              </TableHead>
            }
            onOpen={nativeOff.artifact ? undefined : (path) => onAction?.({ kind: 'open_artifact', path })}
          >
            {files.map((f) => (
              <TableRow key={f.path} id={f.path}>
                <TableCell mono>
                  <span title={f.path}>{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                </TableCell>
                <TableCell>{OP[f.op]}</TableCell>
                <TableCell num>{f.op === 'read' ? '—' : `+${f.added ?? 0} −${f.removed ?? 0}`}</TableCell>
              </TableRow>
            ))}
          </Table>
        </Fold>
      )}
      {codeLive && (
        <section className={styles.sec} aria-label="会话">
          <SecHead
            title="会话"
            right={
              linesFailed && (
                <Btn size="sm" variant="quiet" onClick={() => onRetryLines?.()}>
                  重试
                </Btn>
              )
            }
          />
          <RawFold summary={linesFailed ? ['会话输出没读到'] : sessionLines == null ? ['正在读取会话输出…'] : lines.length > 0 ? lines.slice(-1) : ['还没有输出']} raw={lines.length > 0 ? lines.map((l) => `› ${l}`).join('\n') : undefined} rawLabel="会话输出" />
          <div className={styles.send}>
            <input className={styles.input} placeholder="给这个会话补一句…" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="给编码会话发消息" />
            <Btn
              variant="secondary"
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
            <Btn variant="ghost" icon="ext" disabled={!sessionId || nativeOff.jump != null} disabledReason={nativeOff.jump ?? '没有找到会话'} onClick={() => sessionId && onAction?.({ kind: 'jump_terminal', sessionId })}>
              跳到终端
            </Btn>
          </div>
        </section>
      )}
      {verify && (
        <section className={styles.sec} aria-label="检查">
          <SecHead title="检查" />
          <RawFold summary={[verify.exit_code != null ? `${verifyText(verify)} │ 退出码 ${verify.exit_code}` : verifyText(verify)]} raw={verify.output_tail || undefined} rawLabel="检查输出" />
        </section>
      )}
      {meta.length > 0 && <KV items={meta} />}
    </>
  );
}
