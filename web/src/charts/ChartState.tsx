import type { ReactNode } from 'react';
import { formatClock } from '../domain';
import { InfoTip } from '../ui';
import { ShapeGlyph } from './StateMark';
import styles from './ChartState.module.css';

/** Data state of one chart. `error` and `disconnected` keep the last data visible. */
export type ChartStatus = 'ok' | 'loading' | 'empty' | 'error' | 'disconnected';

/** 图表四态外壳：加载骨架；空态写原因；出错和断开时旧数据照常显示，只加时间签「hh:mm 的数据」。 */
export interface ChartStateProps {
  /** 当前状态 */
  state: ChartStatus;
  /** 空态文案：写原因和下一步，不写「暂无数据」 */
  emptyText: string;
  /** 出错或断开时，旧数据的时间（epoch ms） */
  stoppedAt?: number;
  /** 出错时的重试 */
  onRetry?: () => void;
  /** 骨架高度 px，和正常态一致 */
  height?: number;
  /** 图依赖的后端字段编号：接原生桥时还没有数据，图换成「—」加 ⓘ「后台暂不提供」；假桥照常画 mock 数据 */
  need?: number;
  /** 图本体；出错和断开时仍渲染（旧数据） */
  children: ReactNode;
}

/** No native bridge injected: the data comes from the fake bridge's mocks. */
const isMock = () => typeof window !== 'undefined' && window.agenticComplex == null;

export function ChartState({ state, emptyText, stoppedAt, onRetry, height, need, children }: ChartStateProps) {
  const tag = stoppedAt != null && (
    <>
      {' │ '}
      <span className={styles.num}>{formatClock(stoppedAt)}</span> 的数据
    </>
  );
  if (need != null && !isMock()) {
    return (
      <div data-stub="ChartState" data-state="missing" className={styles.root}>
        <p className={styles.missing}>
          <span className={styles.num}>—</span>
          <InfoTip>后台暂不提供</InfoTip>
        </p>
      </div>
    );
  }
  return (
    <div data-stub="ChartState" data-state={state} className={styles.root} aria-busy={state === 'loading' || undefined}>
      {state === 'loading' && (
        <div className={styles.skel} style={{ minHeight: height ?? 32 }}>
          <span>正在读取…</span>
        </div>
      )}
      {state === 'empty' && (
        <p className={styles.empty}>
          <ShapeGlyph shape="dot" token="--ef-text-3" />
          {emptyText}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className={styles.error}>
          <ShapeGlyph shape="square" token="--ef-state-failed" />
          <span>读取失败{tag}</span>
          {onRetry && (
            <button type="button" className={styles.retry} onClick={onRetry}>
              重试
            </button>
          )}
        </p>
      )}
      {state === 'disconnected' && (
        <p role="status" className={styles.offline}>
          <ShapeGlyph shape="hollow-square" token="--ef-text-3" />
          <span>已断开{tag}</span>
        </p>
      )}
      {(state === 'ok' || state === 'error' || state === 'disconnected') && (
        <div data-stale={state !== 'ok' || undefined}>{children}</div>
      )}
    </div>
  );
}

const STOP = new Date(2026, 9, 29, 14, 31).getTime();

export const ChartStateDemos: Array<{ name: string; props: ChartStateProps }> = [
  { name: 'ok', props: { state: 'ok', emptyText: '现在没有在跑的任务', children: '图本体' } },
  { name: 'loading', props: { state: 'loading', emptyText: '现在没有在跑的任务', height: 48, children: '图本体' } },
  { name: 'empty', props: { state: 'empty', emptyText: '今天还没有活动 │ 派发一个任务后这里会出现运行条', children: '图本体' } },
  { name: 'error', props: { state: 'error', emptyText: '今天还没有活动', stoppedAt: STOP, onRetry: () => undefined, children: '图本体（旧数据）' } },
  { name: 'disconnected', props: { state: 'disconnected', emptyText: '今天还没有活动', stoppedAt: STOP, children: '图本体（旧数据）' } },
  { name: 'need', props: { state: 'ok', emptyText: '今天还没有活动', need: 16, children: '图本体（mock 数据）' } },
];
