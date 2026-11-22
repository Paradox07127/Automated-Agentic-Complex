import type { ReactNode } from 'react';
import type { VisualStateKey } from '../../domain/states';
import { stateVisual } from '../../domain/status';
import { StateGlyph } from './StateGlyph';
import styles from './StateStrip.module.css';

/** 设备状态条（游戏 BuildingState*）：24 高，贴在面板底边。在跑、空闲、待处理、完成是细条（底线淡色 + 中段实心）；失败（红）、注意 / 堵住（橙）、已停 / 暂停（灰）是整条斜纹带。形状、字和一句原因；状态词和形状取 domain/status.ts。 */
export interface StateStripProps {
  /** 状态（domain/status.ts 的键） */
  state: VisualStateKey;
  /** 改写状态词（「出错了」「堵住」「已暂停」）；不给用 status.ts 的词 */
  label?: string;
  /** 一句原因，写在词后面 */
  why?: ReactNode;
}

const BAND = new Set(['failed', 'warning', 'cancelled']);

export function StateStrip({ state, label, why }: StateStripProps) {
  const v = stateVisual(state);
  return (
    <span className={styles.strip} data-stub="StateStrip" data-tone={v.tone} data-band={BAND.has(v.tone) || undefined}>
      {v.tone === 'running' ? (
        <span className={styles.chev} aria-hidden="true" data-shape="ring">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <StateGlyph shape={v.shape} />
      )}
      <span className={styles.word}>{label ?? v.label}</span>
      {why != null && <span className={styles.why}>│ {why}</span>}
    </span>
  );
}

export const StateStripDemos: Array<{ name: string; props: StateStripProps }> = [
  { name: 'running', props: { state: 'running', label: '在跑', why: '等 2 个请求' } },
  { name: 'idle', props: { state: 'idle', why: '上次 14:02' } },
  { name: 'waiting', props: { state: 'waiting', label: '待确认', why: '3 条' } },
  { name: 'failed', props: { state: 'failed', label: '出错了', why: '整理失败' } },
  { name: 'blocked', props: { state: 'warning', label: '堵住', why: '截图额度已满' } },
  { name: 'paused', props: { state: 'stopped', label: '已暂停', why: '观察已关' } },
];
