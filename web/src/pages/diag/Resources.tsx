import { ChartState, LineChart, type ChartStatus, type LineSeries } from '../../charts';
import { formatClock, fpsReadout, msReadout, type RenderSample, type WireDiagBudget } from '../../domain';
import { useThrottled } from '../../domain/useThrottled';
import type { AvatarDetails } from '../../bridge/protocol';
import { RawFold } from '../../features/trace';
import { SecHead } from '../../ui';
import { detailRaw, detailSummary, hasDetails } from './avatarDetails';
import { cpuText, memText } from './procText';
import { DgBars, UsageCard, type BarRow } from './UsageCard';
import styles from './Res.module.css';

const FRAME_BUDGET_MS = 16.7;
const hms = (t: number) => formatClock(t, { seconds: true });

export interface ResourcesProps {
  samples: RenderSample[];
  /** Why there are no frame samples. */
  renderWhy: string;
  /** avatar.details: renderer, quality and the host's last error, folded under the frame plate. */
  details: AvatarDetails | null;
  budget: WireDiagBudget | null;
  /** Process CPU and memory over 30 minutes; null while no source keeps that history. */
  procHistory: { cpu: LineSeries[]; mem: LineSeries[] } | null;
  /** The supervised processes' last CPU and memory reading, drawn while there is no history. */
  procNow: Array<{ k: string; label: string; cpu: number | null; mem: number | null }>;
  /** `内存 … · CPU …` summed over the supervised processes. */
  totals: string | null;
  st: ChartStatus;
  stoppedAt?: number;
}

/** 资源：frame plate in focus, CPU and memory by process, today's usage; series in grey with one emphasis. */
export function Resources({ samples, renderWhy, details, budget, procHistory, procNow, totals, st, stoppedAt }: ResourcesProps) {
  const cpuNow: BarRow[] = procNow.flatMap((p) => (p.cpu != null ? [{ k: p.k, label: p.label, v: p.cpu }] : []));
  const memNow: BarRow[] = procNow.flatMap((p) => (p.mem != null ? [{ k: p.k, label: p.label, v: p.mem }] : []));
  // The readouts take a new sample at most once a second; the charts draw every one.
  const cur = useThrottled([...samples].reverse().find((s) => s.fps != null) ?? null);
  const over = samples.filter((s) => s.p95_ms != null && s.p95_ms > FRAME_BUDGET_MS).length;
  const fst: ChartStatus = st !== 'ok' ? st : samples.length ? 'ok' : 'empty';
  const pause = samples.find((s) => s.suspended);
  return (
    <section className={styles.sec} aria-label="资源" id="diag-usage" data-nav-target="diag-usage">
      <SecHead no="03" title="资源" right={totals ? <span className={styles.t2}>{totals}</span> : null} />
      <div className={styles.fps} data-nav-target="diag-render">
        <span className={styles.plateNo}>帧</span>
        <div className={styles.fpsK}>
          <span className={styles.t3}>帧率 │ 60 秒</span>
          <span className="num">
            <span className={`${styles.big} ${styles.fpsN}`}>{fpsReadout(cur?.fps)}</span> fps
          </span>
          <span className={styles.kv}>
            <span>
              P95 <b className={`num ${styles.ms}`}>{msReadout(cur?.p95_ms)}</b>
            </span>
            <span>
              GPU <b className={`num ${styles.ms}`}>{msReadout(cur?.gpu_ms)}</b>
            </span>
          </span>
          {over > 0 && (
            <span className={styles.warn}>
              <span className={styles.ic} aria-hidden="true">
                ▲
              </span>
              P95 超出预算 {over} 秒
            </span>
          )}
        </div>
        <div className={styles.fpsC}>
          <span className={styles.t3}>帧率</span>
          <ChartState state={fst} emptyText={renderWhy} stoppedAt={stoppedAt} height={92}>
            <LineChart
              label="帧率 60 秒"
              h={92}
              series={[{ id: 'fps', label: '帧率', pts: samples.map((s) => [s.at, s.fps]) }]}
              emph="fps"
              yMin={30}
              yMax={66}
              fmtY={(v) => (v == null ? '暂停' : String(Math.round(v)))}
              fmtT={hms}
              marks={pause ? [{ t: pause.at, label: '画面暂停' }] : []}
            />
          </ChartState>
        </div>
        <div className={styles.fpsC}>
          <span className={styles.t3}>帧耗时 │ ms</span>
          <ChartState state={fst} emptyText={renderWhy} stoppedAt={stoppedAt} height={92}>
            <LineChart
              label="帧耗时 P95 和 GPU"
              h={92}
              series={[
                { id: 'p95', label: 'P95', pts: samples.map((s) => [s.at, s.p95_ms]) },
                { id: 'gpu', label: 'GPU', pts: samples.map((s) => [s.at, s.gpu_ms]) },
              ]}
              emph="p95"
              yMin={0}
              yMax={30}
              fmtY={(v) => (v == null ? '—' : String(Math.round(v)))}
              fmtT={hms}
            />
          </ChartState>
        </div>
      </div>
      {hasDetails(details) && (
        <div className={styles.host}>
          <RawFold summary={detailSummary(details)} raw={detailRaw(details)} rawLabel="宿主详情" />
        </div>
      )}
      <div className={styles.res2} data-one={(!procHistory && procNow.length === 0) || undefined}>
        {!procHistory && procNow.length > 0 && (
          <div className={styles.blk}>
            <div className={styles.bh}>
              <b>CPU 和内存</b>
              <span className={styles.t3}>当前 │ 按进程</span>
            </div>
            <span className={styles.t3}>CPU │ 单核占比</span>
            <DgBars label="CPU 按进程" rows={cpuNow} fmt={cpuText} />
            <span className={styles.t3}>内存</span>
            <DgBars label="内存按进程" rows={memNow} fmt={memText} />
          </div>
        )}
        {procHistory && (
          <div className={styles.blk}>
            <div className={styles.bh}>
              <b>CPU 和内存</b>
              <span className={styles.t3}>30 分钟 │ 按进程</span>
            </div>
            <div className={styles.pair}>
              <div>
                <span className={styles.t3}>CPU</span>
                <LineChart label="CPU 按进程" st={st} h={92} series={procHistory.cpu} emph="角色" yMin={0} yMax={20} fmtY={(v) => `${Math.round(v ?? 0)}%`} />
              </div>
              <div>
                <span className={styles.t3}>内存 │ MB</span>
                <LineChart label="内存按进程" st={st} h={92} series={procHistory.mem} emph="角色" yMin={150} yMax={450} fmtY={(v) => String(Math.round(v ?? 0))} />
              </div>
            </div>
          </div>
        )}
        <UsageCard budget={budget} st={st} />
      </div>
    </section>
  );
}
