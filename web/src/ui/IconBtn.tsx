import { Icon, type IconName } from './Icon';
import styles from './IconBtn.module.css';

/** 图标按钮（深色药丸；close 为圆形点按区）：必须有 aria-label 和 tooltip。 */
export interface IconBtnProps {
  /** 图标 */
  icon: IconName;
  /** aria-label 与 tooltip */
  label: string;
  /** 50×32 / 44×28（close 为 32 / 28 圆），默认 md */
  size?: 'md' | 'sm';
  /** 切换类按钮的按下态 */
  pressed?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 点击 */
  onClick?: () => void;
}

export function IconBtn({ icon, label, size = 'md', pressed, disabled, onClick }: IconBtnProps) {
  return (
    <button
      type="button"
      className={styles.btn}
      data-stub="IconBtn"
      data-icon={icon}
      data-size={size}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  );
}

export const IconBtnDemos: Array<{ name: string; props: IconBtnProps }> = [
  { name: 'close', props: { icon: 'close', label: '关闭' } },
  { name: 'more', props: { icon: 'more', label: '更多操作', size: 'sm' } },
  { name: 'pressed', props: { icon: 'pin', label: '固定', pressed: true, size: 'sm' } },
  { name: 'disabled', props: { icon: 'refresh', label: '重新检测', disabled: true } },
];
