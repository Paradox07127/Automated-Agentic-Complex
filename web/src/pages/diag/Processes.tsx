import { Btn, SecHead, Skel } from '../../ui';
import { GameSeg } from '../../ui/game';
import { ProcRow } from './ProcRow';
import { cpuText, memText } from './procText';
import type { DiagProcess, ProcKey } from './status';
import type { RowAction } from './useDiagActions';
import type { ProcSample } from './useProcSamples';
import styles from './Proc.module.css';

export type { UptimeSeg } from './demoSlot';

export interface ProcessesProps {
  /** supervisor.state rows; null before the first read. */
  rows: DiagProcess[] | null;
  /** Why supervisor.state could not be read. */
  error: string | null;
  onRetry: () => void;
  samples: readonly ProcSample[];
  now: number;
  metric: 'cpu' | 'mem';
  onMetric: (m: 'cpu' | 'mem') => void;
  /** Uptime per process; only agentd reports its start. */
  uptime: Partial<Record<ProcKey, string>>;
  /** agentd is gone: its row stops. */
  agentdGone: boolean;
  actions: Partial<Record<ProcKey, RowAction>>;
  highlight: ProcKey | null;
  onRestart: (target: 'agentd' | 'avatar') => void;
  onLogs: (key: ProcKey) => void;
}

/** 进程：one statistic row per supervised process; the CPU / 内存 switch picks what every curve draws. */
export function Processes({ rows, error, onRetry, samples, now, metric, onMetric, uptime, agentdGone, actions, highlight, onRestart, onLogs }: ProcessesProps) {
  const cpu = rows?.reduce((a, p) => a + (p.cpu_percent ?? 0), 0) ?? 0;
  const mem = rows?.reduce((a, p) => a + (p.memory_mb ?? 0), 0) ?? 0;
  const mins = Math.max(1, Math.round((now - (samples[0]?.at ?? now)) / 60_000));
  return (
    <section className={styles.sec} aria-label="进程">
      <SecHead
        title="进程"
        count={rows?.length}
        micro="PROCESS MONITOR"
        info="CPU 是单核占比，可以超过 100%。曲线是本页打开以来的读数，最多留 30 分钟。"
        right={
          <>
            {rows && (
              <span className={styles.total}>
                合计 CPU <b className="num">{cpuText(cpu)}</b> │ 内存 <b className="num">{memText(mem)}</b>
              </span>
            )}
            <GameSeg
              label="曲线"
              size="compact"
              value={metric}
              options={[
                { value: 'cpu', label: 'CPU' },
                { value: 'mem', label: '内存' },
              ]}
              onChange={(v) => onMetric(v === 'mem' ? 'mem' : 'cpu')}
            />
          </>
        }
      />
      {error && !rows ? (
        <div className={styles.empty} role="status">
          <b>读不到进程状态</b>
          <span>{error}</span>
          <Btn size="sm" icon="refresh" onClick={onRetry}>
            重试
          </Btn>
        </div>
      ) : !rows ? (
        <Skel rows={3} shape="cards" />
      ) : (
        <>
          <div className={styles.board}>
            {rows.map((p) => (
              <ProcRow
                key={p.key}
                p={p}
                metric={metric}
                samples={samples}
                now={now}
                uptime={uptime[p.key] ?? null}
                stale={agentdGone && p.key === 'agentd'}
                action={actions[p.key]}
                highlight={highlight === p.key}
                onLogs={() => onLogs(p.key)}
                onRestart={() => onRestart(p.key as 'agentd' | 'avatar')}
              />
            ))}
          </div>
          <p className={styles.legend}>
            {metric === 'cpu' ? 'CPU' : '内存'} │ 本页打开以来 <span className="num">{mins}</span> 分钟
          </p>
        </>
      )}
    </section>
  );
}
