import { useId, type ReactNode } from 'react';
import styles from './Card.module.css';

/**
 * 面板：直角、1 px 描边、无阴影，暗色主题用暗底；卡头只有标题和右侧读数。
 * 禁止嵌套：Card 里不再放 Card，分组用标题加分隔线。
 */
export interface CardProps {
  /** 形态，默认 dark；slab 低一级底色，delivery 描边更明显 */
  variant?: 'dark' | 'slab' | 'delivery';
  /** 卡头标题 */
  title?: string;
  /** 卡头右侧 */
  right?: ReactNode;
  /** 内容（不放 Card） */
  children: ReactNode;
}

export function Card({ variant = 'dark', title, right, children }: CardProps) {
  const headId = useId();
  return (
    <section className={styles.card} data-stub="Card" data-variant={variant} aria-labelledby={title ? headId : undefined}>
      {(title || right) && (
        <header className={styles.head}>
          {title && (
            <h3 id={headId} className={styles.title}>
              {title}
            </h3>
          )}
          {right && <span className={styles.right}>{right}</span>}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export const CardDemos: Array<{ name: string; props: CardProps }> = [
  { name: 'dark', props: { title: '今天', children: '截图 37/200 │ 外发云端 25 次' } },
  { name: 'slab', props: { variant: 'slab', title: '外发总览', right: '本次启动以来', children: '设置行和动作行的底' } },
  { name: 'delivery', props: { variant: 'delivery', title: '交付第 2 版', children: '2026-W44 周报.md │ 6.2 KB' } },
  { name: 'bare', props: { children: '没有卡头的面板' } },
];
