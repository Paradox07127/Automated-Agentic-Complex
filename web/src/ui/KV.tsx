import type { ReactNode } from 'react';
import { Missing } from './Missing';
import styles from './KV.module.css';

/** 一条键值；value 为 null 或 undefined 时显示「—」。 */
export interface KVItem {
  key: string;
  value: ReactNode | null;
  /** 值用等宽字（命令、路径、id） */
  mono?: boolean;
}

/** 键值列表：键 12/text-2，值 13/text-1，值可以用等宽字；缺数据显示「—」。 */
export interface KVProps {
  /** 各行，按顺序显示 */
  items: KVItem[];
}

export function KV({ items }: KVProps) {
  return (
    <dl className={styles.kv} data-stub="KV">
      {items.map((it) => (
        <div key={it.key} className={styles.row}>
          <dt className={styles.key}>{it.key}</dt>
          {it.value == null ? (
            <dd className={styles.value}>
              <Missing why="unsupported" />
            </dd>
          ) : (
            <dd className={styles.value} data-mono={it.mono || undefined}>
              {it.value}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

export const KVDemos: Array<{ name: string; props: KVProps }> = [
  {
    name: 'run',
    props: {
      items: [
        { key: '状态', value: '进行中' },
        { key: '开始', value: '14:14' },
        { key: '工作目录', value: '~/Documents/账单', mono: true },
        { key: '命令', value: 'python3 -I summarize.py --month 2026-10', mono: true },
        { key: '退出码', value: null },
      ],
    },
  },
];
