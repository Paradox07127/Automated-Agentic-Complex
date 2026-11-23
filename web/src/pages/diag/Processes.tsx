import type { ServiceId } from '../../bridge/protocol';
import { Btn, Empty, SecHead, Skel } from '../../ui';
import { GameSeg } from '../../ui/game';
import { ProcRow } from './ProcRow';
import { cpuText, memText } from './procText';
import { lampOf, SERVICE_ROWS, type DiagProcess, type ProcKey } from './status';
import type { RowAction } from './useDiagActions';
import type { ProcSample } from './useProcSamples';
import styles from './Proc.module.css';

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
  /** A service's row in 设置 › 服务. */
  onService?: (key: ServiceId) => void;
}

const SERVICES: ReadonlySet<ProcKey> = new Set(SERVICE_ROWS.map(([k]) => k));

/** 进程：one statistic row per supervised process; the CPU / 内存 switch picks what every curve draws. */
export function Processes({ rows, error, onRetry, samples, now, metric, onMetric, uptime, agentdGone, actions, highlight, onRestart, onLogs, onService }: ProcessesProps) {
  const cpu = rows?.reduce((a, p) => a + (p.cpu_percent ?? 0), 0) ?? 0;
  const mem = rows?.reduce((a, p) => a + (p.memory_mb ?? 0), 0) ?? 0;
  const mins = Math.max(1, Math.round((now - (samples[0]?.at ?? now)) / 60_000));
  return (
    <section className={styles.sec} aria-label="进程">
      <SecHead
        title="进程"
        count={rows?.length}
        micro="PROCESS MONITOR"
        info="CPU 是单核占比，可以超过 100%。曲线是近 30 分钟的读数，外壳每 10 秒记一次，本页打开后每次刷新再加一点。"
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
        <Empty
          size="compact"
          title="读不到进程状态"
          desc={error}
          action={
            <Btn size="sm" variant="secondary" icon="refresh" onClick={onRetry}>
              重试
            </Btn>
          }
        />
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
                onFix={onService && SERVICES.has(p.key) && lampOf(p) !== 'ok' ? () => onService(p.key as ServiceId) : undefined}
              />
            ))}
          </div>
          <p className={styles.legend}>
            {metric === 'cpu' ? 'CPU' : '内存'} │ 近 <span className="num">{mins}</span> 分钟
          </p>
        </>
      )}
    </section>
  );
}
