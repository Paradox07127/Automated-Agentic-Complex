import type { ReactNode } from 'react';
import { Diamond, MicroLabel } from './Marks';
import { WhiteCapsule } from './WhiteCapsule';
import styles from './TitleBar.module.css';

/** 组标题条（游戏「能力值 ···」条）：半透明灰条加毛玻璃，白字标题、微型英文、计数（可带总数）、一行说明、「已改 n」，斜纹线饰 `\\──□`，右侧动作槽。 */
export interface TitleBarProps {
  /** 标题 */
  title: string;
  /** 标题后的微型英文 */
  micro?: string;
  /** 这组有几项；给了 `total` 是分子（已开几项） */
  count?: number;
  /** 分母：计数画成「count/total」 */
  total?: number;
  /** 计数用强调色：Saira 黄字，大一号（「舞曲库 06」那种整页的总数） */
  countAccent?: boolean;
  /** 这组改了几项；0 或不给不显示 */
  changed?: number;
  /** 「已改」这两个字，默认「已改」（显示页签写「隐藏」） */
  changedLabel?: string;
  /** 计数后的一行说明，放不下时省略 */
  note?: ReactNode;
  /** 右侧动作（白胶囊等） */
  actions?: ReactNode;
}

export function TitleBar({ title, micro, count, total, countAccent, changed, changedLabel = '已改', note, actions }: TitleBarProps) {
  return (
    <div className={styles.bar} data-stub="TitleBar">
      <h3 className={styles.title}>{title}</h3>
      {micro && <MicroLabel>{micro}</MicroLabel>}
      {count != null && (
        <span className={styles.count} data-accent={countAccent || undefined} data-total={total != null || undefined}>
          {count}
          {total != null && <em>/{total}</em>}
        </span>
      )}
      {changed ? (
        <span className={styles.chg}>
          <Diamond tone="yellow" size={6} />
          {changedLabel} {changed}
        </span>
      ) : null}
      {note != null && <span className={styles.note}>{note}</span>}
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
  { name: 'fraction-note', props: { title: '说话', micro: 'Sec / Talk', count: 2, total: 5, note: '开口说话时随机抽一个' } },
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
