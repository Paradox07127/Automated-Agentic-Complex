import type { ReactNode } from 'react';
import { placeAt, type Box } from './WatchKey';
import styles from './StatusRow.module.css';

/** 组件状态行的一格：名字在前、状态在后。 */
export interface StatusRowItem {
  /** 组件名：后台、角色、语音 */
  name: string;
  /** 状态（状态标和词） */
  state: ReactNode;
  /** 出错：左竖线变黄 */
  failed?: boolean;
}

/** 组件状态行：每个组件一块深色小牌，左边一道白竖线（出错时黄）。 */
export interface StatusRowProps {
  items: readonly StatusRowItem[];
  /** 在舞台上的位置和大小；不给时随排版铺开 */
  box?: Box;
  /** 读屏名称，默认「组件状态」 */
  label?: string;
}

export function StatusRow({ items, box, label = '组件状态' }: StatusRowProps) {
  return (
    <div className={styles.status} {...(box && placeAt(box))} role="group" aria-label={label} data-stub="StatusRow">
      {items.map((it) => (
        <span key={it.name} className={styles.item} data-failed={it.failed || undefined}>
          <b>{it.name}</b>
          {it.state}
        </span>
      ))}
    </div>
  );
}

export const StatusRowDemos: Array<{ name: string; props: StatusRowProps }> = [
  {
    name: 'default',
    props: {
      items: [
        { name: '后台', state: '运行中' },
        { name: '角色', state: '运行中' },
        { name: '语音', state: '连不上', failed: true },
      ],
    },
  },
];
