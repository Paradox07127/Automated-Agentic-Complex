import { useMemo, useState, type KeyboardEvent } from 'react';
import { formatClock, formatDuration, type Delivery, type StepEvent, type ToolItem } from '../../domain';
import { ChartState, Waterfall } from '../../charts';
import { ErrBar } from '../../ui';
import { buildLanes, defaultSegment, PHASE_LABEL, toolFamily, toolsIn } from './waterfall';
import styles from './RunWaterfall.module.css';

/** 运行瀑布：每个 generation 一条泳道，工具刻度，终止节点（成功绿 ✓、失败 ✕）；←/→ 切段，可切表格。 */
export interface RunWaterfallProps {
  /** `/agent/tasks/{id}/steps` 事件 */
  steps: StepEvent[];
  /** 工具调用 */
  tools: ToolItem[];
  /** 该任务的交付（画「v1 退回」「交付 v2」竖线） */
  deliveries?: Delivery[];
  /** 当前时间 */
  now: number;
  /** 读取状态；error 表示 `/steps` 不可用 */
  status?: 'ok' | 'loading' | 'error';
  /** 任务还在排队 */
  queued?: boolean;
  /** 工具耗时分布里选中的工具族：它的刻度高亮，其余变淡 */
  highlightTool?: string | null;
  /** 选中的那次运行 */
  generation?: number | null;
  /** 选 generation 芯片 */
  onGeneration?: (g: number | null) => void;
  /** 重试 */
  onRetry?: () => void;
  /** 请求失败时的路径 */
  failedPath?: string;
}

export function RunWaterfall({ steps, tools, deliveries = [], now, status = 'ok', queued, highlightTool = null, generation = null, onGeneration, onRetry }: RunWaterfallProps) {
  const lanes = useMemo(() => buildLanes(steps, tools, deliveries, now), [steps, tools, deliveries, now]);
  const [picked, setPicked] = useState<number | null>(null);
  if (status === 'error') {
    return (
      <div data-stub="RunWaterfall" data-nav-target="run-waterfall" className={styles.root}>
        <ErrBar message="运行步骤详情暂不可用" onRetry={onRetry} />
      </div>
    );
  }
  if (status === 'ok' && (queued || !lanes)) {
    return (
      <div data-stub="RunWaterfall" data-nav-target="run-waterfall" className={styles.root}>
        <div className={styles.queued}>
          <span className={styles.lab}>第 1 次</span>
          <span className={styles.dash}>{queued ? '尚未开始运行 │ 排队中' : '尚无步骤记录'}</span>
        </div>
      </div>
    );
  }
  const segs = lanes?.segments ?? [];
  const genIndex = generation != null ? segs.findIndex((s) => s.generation === generation) : -1;
  const si = picked ?? (genIndex >= 0 ? genIndex : defaultSegment(segs));
  const cur = segs[si];
  const ordinal = (g: number) => (lanes?.generations.findIndex((r) => r.generation === g) ?? -1) + 1;
  const slow = segs.reduce<(typeof segs)[number] | undefined>((a, s) => (!a || s.end - s.start > a.end - a.start ? s : a), undefined);
  const ticks = (lanes?.ticks ?? []).map((t) => ({ ...t, highlight: highlightTool != null && toolFamily(t.label) === highlightTool }));
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setPicked(Math.max(0, Math.min(segs.length - 1, si + (e.key === 'ArrowRight' ? 1 : -1))));
  };
  return (
    <div data-stub="RunWaterfall" data-nav-target="run-waterfall" className={styles.root} tabIndex={0} role="group" aria-label="运行瀑布，←/→ 在段间移动" onKeyDown={move}>
      {lanes && slow && (
        <div className={styles.head}>
          <span>
            运行 <span className="num">{lanes.generations.length}</span> 次 │ 工具 <span className="num">{tools.length}</span> 次 │ 最慢：{PHASE_LABEL[slow.phase]}{' '}
            <span className="num">{formatDuration(slow.end - slow.start)}</span>
          </span>
          <span className={styles.gens} role="group" aria-label="运行次数">
            {lanes.generations.map((g) => (
              <button
                key={g.generation}
                type="button"
                className={styles.gen}
                data-outcome={g.outcome}
                aria-pressed={generation === g.generation}
                title={`第 ${ordinal(g.generation)} 次 │ ${g.outcome === 'failed' ? '失败' : g.outcome === 'ok' ? '已完成' : '进行中'}`}
                onClick={() => {
                  setPicked(null);
                  onGeneration?.(generation === g.generation ? null : g.generation);
                }}
              >
                {String(ordinal(g.generation)).padStart(2, '0')}
              </button>
            ))}
          </span>
          <span className={styles.sp} />
          <span className={styles.hint}>←/→ 切换段</span>
        </div>
      )}
      <ChartState state={status === 'loading' ? 'loading' : 'ok'} emptyText="还没开始运行" height={120}>
        {lanes && (
          <Waterfall
            rows={lanes.rows}
            totalMs={lanes.t1 - lanes.t0}
            label="运行瀑布"
            ticks={ticks}
            marks={lanes.marks}
            terminal={lanes.terminal}
            selected={cur ? { row: cur.row, index: cur.index } : null}
            onPick={(row, index) => setPicked(segs.findIndex((s) => s.row === row && s.index === index))}
          />
        )}
      </ChartState>
      {cur && status === 'ok' && (
        <p className={styles.sel} aria-live="polite">
          <b>
            第 {ordinal(cur.generation)} 次 │ {PHASE_LABEL[cur.phase]}
          </b>{' '}
          │ {cur.name} │{' '}
          <span className="num">
            {formatClock(cur.start, { seconds: true })} → {cur.status === 'current' ? '现在' : formatClock(cur.end, { seconds: true })} │ {formatDuration(cur.end - cur.start)}
          </span>{' '}
          │ 工具 <span className="num">{toolsIn(cur, tools)}</span> 次
          {cur.status === 'failed' && <span className={styles.fail}> │ ■ 在这一段失败</span>}
        </p>
      )}
    </div>
  );
}
