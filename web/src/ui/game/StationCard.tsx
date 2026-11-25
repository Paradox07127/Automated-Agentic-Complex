import type { ReactNode } from 'react';
import type { VisualStateKey } from '../../domain/states';
import { stateVisual } from '../../domain/status';
import { Icon, type IconName } from '../Icon';
import { MicroLabel } from './Marks';
import { StateStrip } from './StateStrip';
import styles from './StationCard.module.css';

/** 工位卡（游戏设备面板缩小版）：顶上编号 + 微型英文 + 细线；左边深色斜纹图标块（两个主题都深）；名字、大数和单位；副行；底边 StateStrip。可点，选中是黄外框加顶边黄条从左长出；往右下投影。 */
export interface StationCardProps {
  /** 编号：01 */
  no: string;
  /** 编号后的微型英文：OBSERVE */
  micro: string;
  icon: IconName;
  name: string;
  /** 大数；没有时写「—」 */
  value: ReactNode;
  /** 大数后的小号单位（「/40」） */
  unit?: string;
  /** 大数后的一句小字（「今天理解」）或计量条 */
  note?: ReactNode;
  /** 副行：最近几次结果、她认为你在… */
  sub?: ReactNode;
  /** 底边状态（domain/status.ts 的键） */
  state: VisualStateKey;
  /** 改写底边的状态词 */
  stateLabel?: string;
  /** 底边的一句原因 */
  why?: ReactNode;
  selected?: boolean;
  /** 在一排工位卡（role=tablist）里：写 role=tab、aria-selected；否则是按钮、aria-pressed */
  tab?: boolean;
  /** 紧凑款：矮一档，小图标块、小一号的大数 */
  compact?: boolean;
  onSelect: () => void;
}

/** Text in a flex box clips mid-glyph; in this span it ends in an ellipsis instead. */
const clip = (x: ReactNode) => (typeof x === 'string' ? <span className={styles.clip}>{x}</span> : x);

export function StationCard({ no, micro, icon, name, value, unit, note, sub, state, stateLabel, why, selected = false, tab, compact, onSelect }: StationCardProps) {
  const word = stateLabel ?? stateVisual(state).label;
  return (
    <button
      type="button"
      className={styles.card}
      data-stub="StationCard"
      data-depth=""
      data-compact={compact || undefined}
      role={tab ? 'tab' : undefined}
      aria-selected={tab ? selected : undefined}
      aria-pressed={tab ? undefined : selected}
      aria-label={`${name}：${word}${typeof why === 'string' ? `，${why}` : ''}`}
      onClick={onSelect}
    >
      <span className={styles.no}>
        {no}
        <MicroLabel>{micro}</MicroLabel>
      </span>
      <span className={styles.icon} aria-hidden="true">
        <Icon name={icon} size={compact ? 20 : 24} />
      </span>
      <span className={styles.name}>{name}</span>
      <span className={styles.big}>
        <b className="num">
          {value}
          {unit && <em>{unit}</em>}
        </b>
        {note != null && <small>{clip(note)}</small>}
      </span>
      <span className={styles.sub}>{clip(sub)}</span>
      <span className={styles.strip}>
        <StateStrip state={state} label={stateLabel} why={why} />
      </span>
    </button>
  );
}

const noop = () => undefined;

export const StationCardDemos: Array<{ name: string; props: StationCardProps }> = [
  { name: 'running', props: { no: '01', micro: 'OBSERVE', icon: 'look', name: '观察', value: '12', unit: '/40', sub: '今日截图 │ 最近 6 次', state: 'running', stateLabel: '运行中', why: '排队 2 个请求', onSelect: noop } },
  { name: 'selected', props: { no: '02', micro: 'INTERPRET', icon: 'kernel', name: '理解', value: '18', note: '今日理解', sub: '推断当前活动：编程', state: 'idle', why: '上次 14:02', selected: true, onSelect: noop } },
  { name: 'failed', props: { no: '03', micro: 'CONSOLIDATE', icon: 'data', name: '整理', value: '4', note: '今日整理批次', sub: '写入 7 条', state: 'failed', stateLabel: '出错', why: '整理失败', onSelect: noop } },
  { name: 'waiting', props: { no: '04', micro: 'MEMORY', icon: 'hub', name: '记忆库', value: '326', note: '已存储', sub: '今日 +5', state: 'waiting', stateLabel: '待确认', why: '3 条', onSelect: noop } },
];
