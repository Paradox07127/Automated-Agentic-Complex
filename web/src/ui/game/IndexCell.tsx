import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import styles from './IndexCell.module.css';

/** 百科索引格（游戏百科 TabCell）：46 高的浮起板子，左图标、名称、右端计数；按下时深色板、黄竖条、黄图标；有待处理时右上一个红点菱形。 */
export interface IndexCellProps {
  /** 左端图标 */
  icon: ReactNode;
  /** 名称 */
  label: string;
  /** 右端计数；不给不画 */
  count?: number | string;
  /** 有待处理：右上红点，计数加粗 */
  pending?: boolean;
  /** 当前选中的分类 */
  pressed?: boolean;
  onClick?: () => void;
}

export function IndexCell({ icon, label, count, pending, pressed = false, onClick }: IndexCellProps) {
  return (
    <button
      type="button"
      className={styles.cell}
      data-stub="IndexCell"
      aria-pressed={pressed}
      data-pend={pending || undefined}
      data-theme={pressed ? 'dark' : undefined}
      onClick={onClick}
    >
      <i className={styles.yb} aria-hidden="true" />
      <span className={styles.ic}>{icon}</span>
      <span className={styles.ct}>{label}</span>
      {count != null && (
        <span className={`${styles.n} num`} data-count="">
          {count}
        </span>
      )}
      {pending && <i className={styles.rd} role="img" aria-label="有待处理" />}
    </button>
  );
}

export const IndexCellDemos: Array<{ name: string; props: IndexCellProps }> = [
  { name: 'rest', props: { icon: <Icon name="g-memory" size={20} />, label: '全部记忆', count: 128 } },
  { name: 'pressed', props: { icon: <Icon name="g-memory" size={20} />, label: '全部记忆', count: 128, pressed: true } },
  { name: 'pending', props: { icon: <Icon name="bell" size={20} />, label: '待确认', count: 3, pending: true } },
  { name: 'pending-pressed', props: { icon: <Icon name="bell" size={20} />, label: '待确认', count: 3, pending: true, pressed: true } },
  { name: 'no-count', props: { icon: <Icon name="star" size={20} />, label: '收藏' } },
  { name: 'unknown-count', props: { icon: <Icon name="g-file" size={20} />, label: '文件', count: '—' } },
];
