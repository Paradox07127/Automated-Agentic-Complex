import styles from './Kbd.module.css';

/** 键帽：最小 18×18，DIN 11。 */
export interface KbdProps {
  /** 按键文字 */
  children: string;
  /** 18 / 20 高，默认 md */
  size?: 'md' | 'lg';
  /** 挂在桌面结构线上：hud-row 底、text-1 字，白色桌面上也够对比度 */
  hud?: boolean;
}

export function Kbd({ children, size = 'md', hud }: KbdProps) {
  return (
    <kbd
      className={styles.kbd}
      data-stub="Kbd"
      data-size={size}
      data-hud={hud || undefined}
      data-cjk={/[㐀-鿿]/.test(children) || undefined}
    >
      {children}
    </kbd>
  );
}

export const KbdDemos: Array<{ name: string; props: KbdProps }> = [
  { name: 'esc', props: { children: 'esc' } },
  { name: 'enter', props: { children: '⏎' } },
  { name: 'chord', props: { children: '⌃⌥A' } },
  { name: 'lg', props: { children: 'Q', size: 'lg' } },
  { name: 'hud', props: { children: 'esc', hud: true } },
];
