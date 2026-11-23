import { formatClock, fpsReadout, type RenderSample } from '../../domain';
import { useThrottled } from '../../domain/useThrottled';
import type { AvatarDetails } from '../../bridge/protocol';
import { LineChart, type Pt } from '../../charts';
import { RawFold } from '../../features/trace';
import { Btn, KV, SecHead } from '../../ui';
import { GameFrame, ReadTick } from '../../ui/game';
import { detailRaw, hasDetails, rendererName, suspendedText } from './avatarDetails';
import styles from './Res.module.css';

export const FRAME_BUDGET_MS = 16.7;
const hms = (t: number) => formatClock(t, { seconds: true });
/** Fits two charts side by side above the host details at 600 px high. */
const CHART_H = 180;
const num1 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1));

/** Seconds of the samples whose P95 frame time went over the 60 fps budget. */
export const overBudget = (samples: readonly RenderSample[]) => samples.filter((s) => s.p95_ms != null && s.p95_ms > FRAME_BUDGET_MS).length;

export interface ResourcesProps {
  samples: RenderSample[];
  /** Why there are no frame samples. */
  renderWhy: string;
  /** avatar.details: renderer, quality and the host's last error. */
  details: AvatarDetails | null;
  onProc: () => void;
  /** The 角色 log on 日志. */
  onLogs?: () => void;
}

/** 渲染：the frame readings large, frame rate and frame time over the last minute side by side, then the host's details. */
export function Resources({ samples, renderWhy, details, onProc, onLogs }: ResourcesProps) {
  // The readouts take a new sample at most once a second; the charts draw every one.
  const cur = useThrottled([...samples].reverse().find((s) => s.fps != null) ?? null);
  const over = overBudget(samples);
  const p = details?.pipeline ?? null;
  const t1 = samples.at(-1)?.at ?? 0;
  const t0 = t1 - 59_000;
  const none = samples.length === 0;
  return (
    <section className={styles.sec} aria-label="渲染">
      <SecHead
        title="帧"
        micro="FRAME 60 S"
        info="帧数据来自宿主每秒一次的上报；暂停时不读。"
        right={
          <>
            <span>近 60 秒 │ 每秒一个读数</span>
            {none && (
              <Btn size="sm" onClick={onProc}>
                去进程
              </Btn>
            )}
          </>
        }
      />
      <div className={styles.band} data-nav-target="diag-render">
        <ReadTick size="lg" value={fpsReadout(cur?.fps)} unit="fps" label={p ? `帧率 │ 目标 ${p.fpsTarget}` : '帧率'} />
        <ReadTick size="lg" value={num1(cur?.p95_ms)} unit="ms" label={`P95 帧耗时 │ 超预算 ${over} 秒`} tone={over > 0 ? 'warn' : 'main'} />
        <ReadTick size="lg" value={num1(cur?.gpu_ms)} unit="ms" label="GPU" tone="ink" />
        <ReadTick size="lg" value={p ? String(Math.round(p.gpuAllocatedMB)) : '—'} unit={p ? 'MB' : undefined} label="显存" tone="ink" />
        <span className={styles.opt}>
          <ReadTick size="lg" value={p ? String(p.fpsRequested) : '—'} unit={p ? 'fps' : undefined} label={p ? `请求帧率 │ ${p.suspended != null || p.fpsRequested === 0 ? '暂停中' : '没有暂停'}` : '请求帧率'} tone="ink" />
        </span>
      </div>
      <div className={styles.charts}>
        <GameFrame variant="chart" compact title="帧率" micro="FRAME RATE 60 S" label="帧率">
          <div className={styles.plot}>
            <LineChart
              label="帧率 60 秒"
              series={[{ id: 'fps', label: '帧率', pts: samples.map((s) => [s.at, s.fps] as Pt) }]}
              t0={t0}
              t1={t1}
              yMin={20}
              yMax={66}
              h={CHART_H}
              area
              limit={[
                { v: 60, label: '目标 60', name: '目标线' },
                { v: 30, label: '过低 30', tone: 'danger', name: '过低线' },
              ]}
              fmtY={(v) => (v == null ? '—' : `${Math.round(v)} fps`)}
              fmtT={hms}
              st={none ? 'empty' : 'ok'}
              empty={renderWhy}
            />
          </div>
        </GameFrame>
        <GameFrame variant="chart" compact title="帧耗时" micro="FRAME TIME MS" label="帧耗时">
          <div className={styles.plot}>
            <LineChart
              label="帧耗时 P95 和 GPU"
              series={[
                { id: 'p95', label: 'P95', pts: samples.map((s) => [s.at, s.p95_ms] as Pt) },
                { id: 'gpu', label: 'GPU', pts: samples.map((s) => [s.at, s.gpu_ms] as Pt) },
              ]}
              t0={t0}
              t1={t1}
              yMin={0}
              yMax={30}
              h={CHART_H}
              limit={{ v: FRAME_BUDGET_MS, label: `预算 ${FRAME_BUDGET_MS}`, tone: 'warning', name: '预算线' }}
              fmtY={(v) => (v == null ? '—' : `${v.toFixed(1)} ms`)}
              fmtT={hms}
              st={none ? 'empty' : 'ok'}
              empty={renderWhy}
            />
          </div>
        </GameFrame>
      </div>
      {hasDetails(details) && (
        <GameFrame title="宿主详情" micro="AVATAR DETAILS" label="宿主详情">
          <div className={styles.host}>
            <div className={styles.kv}>
              <KV
                items={[
                  { key: '渲染器', value: rendererName(details.renderer) },
                  { key: '构建', value: details.build ? details.build.slice(0, 8) : null, mono: true },
                  { key: '角色', value: p?.character ?? null },
                ]}
              />
              <KV
                items={[
                  { key: '外观', value: p?.appearance ?? null },
                  { key: '超采样', value: p ? `${p.ssaa}×` : null },
                  { key: '阴影', value: p ? String(p.shadowResolution) : null },
                ]}
              />
              <KV
                items={[
                  { key: '描边', value: p?.outline ?? null },
                  { key: '暂停', value: p ? (p.suspended != null ? suspendedText(p.suspended) : '没有') : null },
                  {
                    key: '上次出错',
                    value: p?.error && onLogs ? (
                      <>
                        {p.error}{' '}
                        <Btn size="sm" variant="text" go onClick={onLogs}>
                          日志
                        </Btn>
                      </>
                    ) : (p?.error ?? (p ? '没有' : null)),
                  },
                ]}
              />
            </div>
            <RawFold raw={detailRaw(details)} rawLabel="宿主详情原文" />
          </div>
        </GameFrame>
      )}
    </section>
  );
}
