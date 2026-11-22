import { useState } from 'react';
import { Sparkline } from '../../charts';
import { formatClock } from '../../domain';
import { Btn, Region, StatusTag, type RegionSource } from '../../ui';
import { cpuText, memText } from './procText';
import type { DiagProcess, ProcessKey } from './status';
import styles from './Proc.module.css';

/** Per-row action state after the user acted: restart in flight, or done. */
export type RowAction = { kind: 'restart'; phase: 'busy' | 'done'; at: number; text?: string };

/** One online segment as a share of the bar. */
export interface UptimeSeg {
  from: number;
  to: number;
  up: boolean;
}

export interface ProcessesProps {
  /** supervisor.state rows; read on their own, not from /diag/state. */
  q: RegionSource<DiagProcess[]>;
  /** Uptime text per process; only agentd reports its start. */
  uptime: Partial<Record<ProcessKey, string>>;
  /** Online segments and CPU history per process; null while no source keeps them. */
  history: { uptime: Partial<Record<ProcessKey, UptimeSeg[]>>; cpu: Partial<Record<ProcessKey, number[]>> } | null;
  actions: Partial<Record<ProcessKey, RowAction>>;
  highlight: ProcessKey | null;
  /** agentd is gone: every row reads unknown since this time (0 when nothing was ever read). */
  staleAt?: number | null;
  onRestart: (target: 'agentd' | 'avatar') => void;
  onLogs: (key: ProcessKey) => void;
  onVoice: () => void;
}

function UptimeBar({ segs }: { segs: UptimeSeg[] }) {
  return (
    <span className={styles.ub} aria-hidden="true">
      {segs.map((s, i) => (
        <i key={i} data-up={s.up || undefined} style={{ left: `${s.from * 100}%`, width: `${(s.to - s.from) * 100}%` }} />
      ))}
    </span>
  );
}

const always = () => false;

/** 进程, part of the health strip: a read-only data table; status, uptime, memory and CPU, then 查看日志 and the row's restart. */
export function Processes({ q, uptime, history, actions, highlight, staleAt = null, onRestart, onLogs, onVoice }: ProcessesProps) {
  const [open, setOpen] = useState(true);
  const processes = q.data;
  const stale = staleAt != null;
  const off = processes?.filter((p) => !p.healthy).length ?? 0;
  const since = staleAt ? `未知 │ 上次 ${formatClock(staleAt)}` : '未知';
  // A value the row lacks: the process is not running, or it runs and does not report it.
  const blank = (p: DiagProcess) => (stale || p.tone === 'running' ? '未知' : '离线');
  return (
    <section className={styles.sec} aria-label="进程">
      <div className={styles.head}>
        <b>进程</b>
        {processes && (
          <span className={styles.t2}>
            <span className="num">{processes.length}</span> 个 │ <span className="num">{stale ? processes.length : off}</span> 个{stale ? '未知' : '离线'}
          </span>
        )}
        <button type="button" className={styles.fold} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </button>
        {staleAt ? (
          <span className={styles.stamp} role="status">
            <span className="num">{formatClock(staleAt)}</span> 的数据
          </span>
        ) : null}
      </div>
      {open && (
        <Region q={q} what="进程" reserve={{ rows: 3 }} isEmpty={always}>
          {(list) => (
            <table className={styles.procs}>
              <thead>
                <tr data-colhead="">
                  <th className={styles.two} />
                  <th className={styles.st} />
                  <th className={styles.up} scope="col">
                    运行时长
                  </th>
                  <th className={styles.mem} scope="col">
                    内存
                  </th>
                  <th className={styles.spk} scope="col">
                    CPU
                  </th>
                  <th className={styles.pa} />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const act = actions[p.key];
                  const busy = act?.phase === 'busy';
                  const segs = history?.uptime[p.key];
                  const cpu = history?.cpu[p.key];
                  const up = uptime[p.key] ?? blank(p);
                  const cpuNow = p.cpu_percent == null ? blank(p) : cpuText(p.cpu_percent);
                  return (
                    <tr key={p.key} className={styles.row} data-hl={highlight === p.key || undefined} data-stale={stale || undefined} data-nav-target={`proc-${p.key}`}>
                      <td className={styles.two}>
                        <b>{p.name}</b>
                        <span>{p.pid != null ? `${p.sub} │ pid ${p.pid}` : p.sub}</span>
                        <span className={styles.meta}>
                          运行时长 <span className="num">{up}</span> │ CPU <span className="num">{cpuNow}</span>
                        </span>
                      </td>
                      <td className={styles.st}>
                        <span className={styles.in}>
                          {busy ? <span className={styles.t2}>◌ 正在重启…</span> : <StatusTag state={stale ? 'idle' : p.tone} label={stale ? since : p.status_text} />}
                          {!busy && p.backoff_s != null && (
                            <span className={styles.t2}>
                              退避 <span className="num">{p.backoff_s}</span> 秒后重试
                            </span>
                          )}
                          {act?.phase === 'done' && act.text && <span className={styles.t2}>{act.text}</span>}
                        </span>
                      </td>
                      <td className={styles.up}>
                        <span className={styles.in}>
                          {segs && <UptimeBar segs={segs} />}
                          <span className={`${styles.t2} num`}>{up}</span>
                        </span>
                      </td>
                      <td className={`${styles.mem} num`}>{p.memory_mb == null ? blank(p) : memText(p.memory_mb)}</td>
                      <td className={styles.spk}>
                        <span className={styles.in}>
                          {cpu && <Sparkline points={cpu} label={`${p.name} CPU`} />}
                          <span className="num">{cpuNow}</span>
                        </span>
                      </td>
                      <td className={styles.pa}>
                        <span className={styles.in}>
                          <Btn variant="text" size="sm" onClick={() => onLogs(p.key)}>
                            查看日志
                          </Btn>
                          {p.restartable ? (
                            <Btn variant="text" size="sm" disabled={busy} disabledReason="正在重启" onClick={() => onRestart(p.key as 'agentd' | 'avatar')}>
                              重启
                            </Btn>
                          ) : p.key === 'voice' ? (
                            <Btn variant="text" size="sm" onClick={onVoice}>
                              前往设置
                            </Btn>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Region>
      )}
    </section>
  );
}
