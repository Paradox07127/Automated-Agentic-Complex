import type { ReactNode } from 'react';
import { Btn } from './Btn';
import { Icon, type IconName } from './Icon';
import styles from './Empty.module.css';

/** 空状态：一行原因加一个动作；写原因和下一步，不写「暂无数据」。 */
export interface EmptyProps {
  /** 原因 */
  title: string;
  /** 补充，接在原因后面，同一行 */
  desc?: ReactNode;
  /** 行首小图标，默认 grid */
  icon?: IconName;
  /** 下一步：只放一个按钮 */
  action?: ReactNode;
}

export function Empty({ title, desc, icon = 'grid', action }: EmptyProps) {
  return (
    <div className={styles.empty} data-stub="Empty" data-icon={icon} role="status">
      <p className={styles.line}>
        <Icon name={icon} size={16} />
        <span className={styles.title}>{title}</span>
        {desc && <span className={styles.desc}>{desc}</span>}
      </p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}

export const EmptyDemos: Array<{ name: string; props: EmptyProps }> = [
  { name: 'default', props: { title: '还没有对话', icon: 'send', action: <Btn variant="secondary" icon="plus">新对话</Btn> } },
  { name: 'filtered', props: { title: '没有符合筛选的任务', desc: '只看失败已打开', icon: 'tune', action: <Btn variant="ghost">清除筛选</Btn> } },
  { name: 'reason-only', props: { title: '今天还没有外发', icon: 'privacy' } },
];
