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
  /** md：页面或整栏的空态（斜纹框）；compact：卡里、面板里的小空态，无框，补充另起一行 */
  size?: 'md' | 'compact';
  /** 列表里的一行：靠左、无框，原因、补充、动作排成一行；只在给了 icon 时画图标 */
  inline?: boolean;
}

export function Empty({ title, desc, icon, action, size = 'md', inline }: EmptyProps) {
  const mark = icon ?? (inline ? undefined : 'grid');
  return (
    <div className={styles.empty} data-stub="Empty" data-icon={mark} data-size={size} data-inline={inline || undefined} role="status">
      <p className={styles.line}>
        {mark && <Icon name={mark} size={16} />}
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
  { name: 'compact', props: { title: '读不到进程状态', desc: '后台已断开，重启后会重新读', size: 'compact', action: <Btn size="sm" variant="secondary" icon="refresh">重试</Btn> } },
  { name: 'inline', props: { title: '今天没有提醒', inline: true } },
  { name: 'inline-action', props: { title: '没找到「周报」', desc: '只搜了做完的任务', inline: true, action: <Btn size="sm" variant="text">清除</Btn> } },
];
