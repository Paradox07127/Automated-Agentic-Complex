import type { ReactNode } from 'react';
import { Diamond, MicroLabel } from './Marks';
import { WhiteCapsule } from './WhiteCapsule';
import styles from './TitleBar.module.css';

/** 组标题条（游戏「能力值 ···」条）：半透明灰条加毛玻璃，白字标题、微型英文、计数、「已改 n」，斜纹线饰 `\\──□`，右侧动作槽。 */
export interface TitleBarProps {
  /** 标题 */
  title: string;
  /** 标题后的微型英文 */
  micro?: string;
  /** 这组有几项 */
  count?: number;
  /** 计数用强调色：Saira 黄字，大一号（「舞曲库 06」那种整页的总数） */
  countAccent?: boolean;
  /** 这组改了几项；0 或不给不显示 */
  changed?: number;
  /** 右侧动作（白胶囊等） */
  actions?: ReactNode;
}

export function TitleBar({ title, micro, count, countAccent, changed, actions }: TitleBarProps) {
  return (
    <div className={styles.bar} data-stub="TitleBar">
      <h3 className={styles.title}>{title}</h3>
      {micro && <MicroLabel>{micro}</MicroLabel>}
      {count != null && (
        <span className={styles.count} data-accent={countAccent || undefined}>
          {count}
        </span>
      )}
      {changed ? (
        <span className={styles.chg}>
          <Diamond tone="yellow" size={6} />
          已改 {changed}
        </span>
      ) : null}
      <span className={styles.deco} aria-hidden="true">
        <i className={styles.slash} />
        <i className={styles.rule} />
        <i className={styles.box} />
      </span>
      {actions != null && <span className={styles.actions}>{actions}</span>}
    </div>
  );
}

export const TitleBarDemos: Array<{ name: string; props: TitleBarProps }> = [
  { name: 'plain', props: { title: '外观', micro: 'Outfits' } },
  { name: 'count-changed', props: { title: '衣服', micro: 'Clothing / 01', count: 3, changed: 2 } },
  { name: 'count-accent', props: { title: '舞曲库', micro: 'MMD Library / Shared', count: 6, countAccent: true } },
  {
    name: 'actions',
    props: {
      title: '说话',
      micro: 'Sec / Talk',
      count: 3,
      actions: <WhiteCapsule label="恢复默认" icon="refresh" />,
    },
  },
];
