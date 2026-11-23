import { formatClock } from '../../domain';
import { LineChart, type Pt } from '../../charts';
import { Btn, Icon, type IconName } from '../../ui';
import { LoadBar, ReadTick, StatusLamp } from '../../ui/game';
import { cpuParts, cpuText, memParts, memText } from './procText';
import { LIMITS, lampOf, levelOf, type DiagProcess, type ProcKey } from './status';
import type { RowAction } from './useDiagActions';
import type { ProcSample } from './useProcSamples';
import styles from './Proc.module.css';

const GLYPH: Record<ProcKey, IconName> = { agentd: 'data', avatar: 'user', tunnel: 'sync' };
const MIN = 60_000;
/** Fits the row's shortest height. */
const CHART_H = 96;

export interface ProcRowProps {
  p: DiagProcess;
  metric: 'cpu' | 'mem';
  samples: readonly ProcSample[];
  now: number;
  /** 运行 1 小时 12 分; null while the process does not report its start. */
  uptime: string | null;
  /** agentd is gone: its row reads 没有响应 and its numbers stop. */
  stale: boolean;
  action: RowAction | undefined;
  highlight: boolean;
  onLogs: () => void;
  onRestart: () => void;
}

/** One process as a statistic row: dark name plate │ curve since the page opened with its two threshold lines │ CPU and memory │ 日志, 重启. */
export function ProcRow({ p, metric, samples, now, uptime, stale, action, highlight, onLogs, onRestart }: ProcRowProps) {
  const lim = LIMITS[p.key];
  const [warn, bad] = lim[metric];
  const pts = samples.map((s) => [s.at, (metric === 'cpu' ? s.cpu : s.mem)[p.key] ?? null] as const);
  const t0 = samples[0]?.at ?? now;
  const peak = Math.max(0, ...pts.map(([, v]) => v ?? 0));
  const max = Math.max(bad * 1.15, peak * 1.05);
  const mins = Math.max(1, Math.round((now - t0) / MIN));
  const fmt = metric === 'cpu' ? cpuText : memText;
  const cpuL = stale ? null : levelOf(p.cpu_percent, lim.cpu);
  const memL = stale ? null : levelOf(p.memory_mb, lim.mem);
  const [cpuV, cpuU] = stale ? ['—', undefined] : cpuParts(p.cpu_percent);
  const [memV, memU] = stale ? ['—', undefined] : memParts(p.memory_mb);
  const state = stale ? 'failed' : lampOf(p);
  const busy = action?.phase === 'busy';
  const few = pts.filter(([, v]) => v != null).length < 2;
  return (
    <div className={styles.row} data-tone={state === 'failed' ? 'bad' : undefined} data-hl={highlight || undefined} data-nav-target={`proc-${p.key}`}>
      <div className={styles.plate}>
        <span className={styles.glyph} aria-hidden="true">
          <Icon name={GLYPH[p.key]} size={20} />
        </span>
        <b className={styles.name}>{p.name}</b>
        <small className={styles.sub}>{p.pid != null ? `${p.sub} │ pid ${p.pid}` : p.sub}</small>
        <span className={styles.state}>
          {busy ? <span className={styles.busy}>◌ 正在重启…</span> : <StatusLamp state={state} label={stale ? '没有响应' : p.status_text} onDark />}
          <small>{p.backoff_s != null && !busy ? `退避 ${p.backoff_s} 秒后重试` : `运行 ${uptime ?? '—'}`}</small>
        </span>
        <i className={styles.bar} aria-hidden="true" />
      </div>
      <div className={styles.cv}>
        <LineChart
          label={`${p.name} ${metric === 'cpu' ? 'CPU' : '内存'}，本页打开以来 ${mins} 分钟`}
          series={[{ id: p.key, label: metric === 'cpu' ? 'CPU' : '内存', pts: pts.map(([t, v]) => [t, v] as Pt) }]}
          t0={t0}
          t1={now}
          yMin={0}
          yMax={max}
          h={CHART_H}
          area
          limit={[
            { v: warn, label: `注意 ${fmt(warn)}` },
            { v: bad, label: `过高 ${fmt(bad)}` },
          ]}
          fmtY={fmt}
          fmtT={(t) => formatClock(t, { seconds: true })}
          st={few ? 'empty' : stale ? 'disconnected' : 'ok'}
          empty="刚开始记录"
          {...(stale && !few ? { stoppedAt: samples.at(-1)?.at ?? now } : {})}
        />
      </div>
      <div className={styles.reads}>
        <ReadTick value={cpuV} unit={cpuU} label="CPU │ 单核占比" tone={cpuL ?? 'main'} />
        <span className={styles.mem}>
          <ReadTick value={memV} unit={memU} label={`内存 │ 注意线 ${memText(lim.mem[0])}`} tone={memL ?? 'ink'} />
          <span className={styles.meter}>
            <LoadBar variant="port" fraction={stale || p.memory_mb == null ? 0 : p.memory_mb / lim.mem[1]} thresholds={[lim.mem[0] / lim.mem[1]]} label={`${p.name}内存，刻度是注意线，满格是过高线`} />
          </span>
        </span>
      </div>
      <div className={styles.acts}>
        <Btn size="sm" icon="file" onClick={onLogs}>
          日志
        </Btn>
        {p.restartable && (
          <Btn size="sm" variant="secondary" icon="refresh" disabled={busy} disabledReason="正在重启" onClick={onRestart}>
            重启
          </Btn>
        )}
        {action?.phase === 'done' && action.text && <span className={styles.done}>{action.text}</span>}
      </div>
    </div>
  );
}
