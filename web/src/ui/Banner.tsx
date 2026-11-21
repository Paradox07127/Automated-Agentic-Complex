import type { ReactNode } from 'react';
import type { Severity } from '../domain';
import { Btn } from './Btn';
import { Icon, type IconName } from './Icon';
import styles from './Banner.module.css';

/** 全局横幅：浅一级底色加 1 px 墨色框，文字前一个黄色小旗；从不用红。 */
export interface BannerProps {
  /** 语义 */
  severity: Severity;
  /** 标题 */
  title: string;
  /** 说明 */
  desc?: ReactNode;
  /** 计时读数，例如「已断开 00:42」 */
  timer?: string;
  /** 操作按钮 */
  actions?: ReactNode;
}

const ICON: Record<Severity, IconName> = { danger: 'stop', warning: 'warn', info: 'moonz', success: 'ok', neutral: 'privacy' };

export function Banner({ severity, title, desc, timer, actions }: BannerProps) {
  return (
    <div role={severity === 'danger' ? 'alert' : 'status'} className={styles.banner} data-stub="Banner" data-severity={severity}>
      <span className={styles.icon}>
        <Icon name={ICON[severity]} size={16} />
      </span>
      <strong className={styles.title}>{title}</strong>
      {timer && (
        <span className={styles.timer}>
          <Icon name="clock" size={14} />
          {timer}
        </span>
      )}
      {desc && <span className={styles.desc}>{desc}</span>}
      {actions && <span className={styles.actions}>{actions}</span>}
    </div>
  );
}

export const BannerDemos: Array<{ name: string; props: BannerProps }> = [
  { name: 'agentd', props: { severity: 'danger', title: '后台服务断开', timer: '已断开 00:42', desc: '下面是 14:31 的数据', actions: <Btn variant="ghost" icon="refresh">重新连接</Btn> } },
  { name: 'warning', props: { severity: 'warning', title: '内核未就绪', desc: 'codex 未登录，编码任务会排队', actions: <Btn variant="ghost">重新检测</Btn> } },
  { name: 'pause', props: { severity: 'info', title: '观察暂停中', desc: '还剩 18 分 │ 14:50 恢复', actions: <Btn variant="ghost">现在恢复</Btn> } },
  { name: 'success', props: { severity: 'success', title: '已恢复连接', desc: '断开 42 秒，期间的事件已补齐' } },
  { name: 'neutral', props: { severity: 'neutral', title: '⟳ 待应用', desc: '2 项设置已保存，重启后台后生效', actions: <Btn variant="secondary">重启后台</Btn> } },
];
