import { Icon, type IconName } from '../Icon';
import styles from './WhiteCapsule.module.css';

/** 白胶囊（游戏「培养总览」「代理人的眷顾」）：白 .85 圆角胶囊，左侧图标在深色小圆里，图标和字之间一条细竖线。 */
export interface WhiteCapsuleProps {
  /** 字 */
  label: string;
  /** 小圆里的图标 */
  icon: IconName;
  /** 小圆：默认黑底白图标；accent 黑底黄图标（这一排的主操作，如「重启角色」「重试」）；dark 是深色胶囊、白字白圆（放在深色横幅上，如「刚导入」的「收起提示」） */
  tone?: 'plain' | 'accent' | 'dark';
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因（悬停提示） */
  disabledReason?: string;
  onClick?: () => void;
}

export function WhiteCapsule({ label, icon, tone = 'plain', disabled, disabledReason, onClick }: WhiteCapsuleProps) {
  return (
    <button type="button" className={styles.cap} data-stub="WhiteCapsule" data-tone={tone} disabled={disabled} title={disabled ? disabledReason : undefined} onClick={onClick}>
      <span className={styles.ic}>
        <Icon name={icon} size={14} />
      </span>
      <i className={styles.bar} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </button>
  );
}

export const WhiteCapsuleDemos: Array<{ name: string; props: WhiteCapsuleProps }> = [
  { name: 'reset', props: { label: '恢复默认', icon: 'refresh' } },
  { name: 'show-all', props: { label: '全部显示', icon: 'eye' } },
  { name: 'accent', props: { label: '重启角色', icon: 'refresh', tone: 'accent' } },
  { name: 'dark', props: { label: '收起提示', icon: 'chev', tone: 'dark' } },
  { name: 'disabled', props: { label: '恢复默认', icon: 'refresh', disabled: true, disabledReason: '已是默认' } },
];
