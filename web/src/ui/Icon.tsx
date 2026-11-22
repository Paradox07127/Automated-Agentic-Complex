import { ICON_PATHS } from './iconPaths';
import styles from './Icon.module.css';

/** Icon names used across the app (prototype ICONS). */
export type IconName =
  | 'search'
  | 'plus'
  | 'close'
  | 'chev'
  | 'chevd'
  | 'chevl'
  | 'ext'
  | 'check'
  | 'more'
  | 'play'
  | 'stop'
  | 'pin'
  | 'sun'
  | 'moon'
  | 'folder'
  | 'eye'
  | 'refresh'
  | 'copy'
  | 'tool'
  | 'file'
  | 'mic'
  | 'side'
  | 'menu'
  | 'info'
  | 'warn'
  | 'hand'
  | 'bell'
  | 'moonz'
  | 'grid'
  | 'user'
  | 'send'
  | 'look'
  | 'loc'
  | 'clock'
  | 'sync'
  | 'kernel'
  | 'keys'
  | 'voice'
  | 'hub'
  | 'privacy'
  | 'shield'
  | 'data'
  | 'tune'
  | 'redeem'
  | 'radio'
  | 'history'
  | 'del'
  | 'ok'
  | 'bolt'
  | 'upload'
  | 'g-chat'
  | 'g-ask'
  | 'g-topic'
  | 'g-new'
  | 'g-pin'
  | 'g-rename'
  | 'g-archive'
  | 'g-delete'
  | 'g-window'
  | 'g-nomem'
  | 'g-file'
  | 'g-memory'
  | 'g-face'
  | 'g-task'
  | 'g-switch'
  | 'g-send'
  | 'g-search'
  | 'g-kernel'
  | 'g-plus'
  | 'g-close'
  | 'g-fold'
  | 'g-shot'
  | 'g-image'
  | 'g-link'
  | 'g-copy'
  | 'g-quote'
  | 'g-trace';

/** 图标：Material Symbols Sharp 实心；装饰时 aria-hidden，独立表意时给 label。 */
export interface IconProps {
  /** 图标名 */
  name: IconName;
  /** 像素尺寸，默认 16 */
  size?: 12 | 14 | 16 | 20 | 24 | 32;
  /** 独立表意时的读屏文字；不给则 aria-hidden */
  label?: string;
}

export function Icon({ name, size = 16, label }: IconProps) {
  return (
    <svg
      className={styles.icon}
      data-stub="Icon"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export const IconDemos: Array<{ name: string; props: IconProps }> = [
  { name: 'default', props: { name: 'check' } },
  { name: 'labelled', props: { name: 'warn', size: 20, label: '警告' } },
  { name: 'large', props: { name: 'kernel', size: 32, label: '角色内核' } },
];
