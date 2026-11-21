import { Icon, type IconName } from './Icon';
import { Kbd } from './Kbd';
import styles from './OptionRow.module.css';

/** 选项行：通讯条按钮、提问卡选项、快捷回复共用；任务行样式，选中换浅色带加斜纹。 */
export interface OptionRowProps {
  /** 文字 */
  label: string;
  /** 左侧图标 */
  icon?: IconName;
  /** 选中 */
  selected?: boolean;
  /** 高 36 / 26，默认 main */
  size?: 'main' | 'desk';
  /** 键帽 */
  kbd?: string;
  /** 点击 */
  onClick?: () => void;
}

export function OptionRow({ label, icon, selected, size = 'main', kbd, onClick }: OptionRowProps) {
  return (
    <button type="button" role="option" aria-selected={!!selected} className={styles.opt} data-stub="OptionRow" data-size={size} data-icon={icon} onClick={onClick}>
      {icon ? (
        <span className={styles.icon}>
          <Icon name={icon} size={size === 'desk' ? 14 : 16} />
        </span>
      ) : selected ? (
        <span className={styles.icon}>
          <Icon name="check" size={size === 'desk' ? 14 : 16} />
        </span>
      ) : null}
      <span className={styles.label}>{label}</span>
      {kbd && (
        <span className={styles.kbd} aria-hidden="true">
          <Kbd>{kbd}</Kbd>
        </span>
      )}
    </button>
  );
}

export const OptionRowDemos: Array<{ name: string; props: OptionRowProps }> = [
  { name: 'default', props: { label: '包含' } },
  { name: 'icon', props: { label: '有用', icon: 'check', kbd: '1' } },
  { name: 'selected', props: { label: '单列一节', selected: true } },
  { name: 'desk', props: { label: '别打扰', size: 'desk', kbd: '2' } },
  { name: 'desk-selected', props: { label: '附上当前窗口', selected: true, size: 'desk' } },
];
