import styles from './Kbd.module.css';

/** 一条键位说明：几个键连成一段，后面是它做什么。 */
export interface KbdItem {
  /** 键帽文字，按顺序连成一段，如 ['Q', 'E'] */
  keys: string[];
  /** 做什么 */
  label: string;
  /** 次要的：窄窗（宽 < 1200 或高 < 620）时收起 */
  more?: boolean;
}

/** 键帽：最小 18×18，DIN 11。variant="bar" 是一条键位说明（底栏左区、面板脚注）：每条的键连成一段，条与条之间空 14。 */
export interface KbdProps {
  /** 按键文字（单个键帽） */
  children?: string;
  /** 18 / 20 高，默认 md */
  size?: 'md' | 'lg';
  /** 挂在桌面结构线上：hud-row 底、text-1 字，白色桌面上也够对比度 */
  hud?: boolean;
  /** key：单个键帽；bar：一条键位说明，用 items */
  variant?: 'key' | 'bar';
  /** bar 的各条说明 */
  items?: KbdItem[];
  /** bar 只在按住 ⌘ / Ctrl 时显示 */
  held?: boolean;
}

const cjk = (text: string) => /[㐀-鿿]/.test(text) || undefined;

export function Kbd({ children = '', size = 'md', hud, variant = 'key', items = [], held }: KbdProps) {
  if (variant === 'bar')
    return (
      <span className={styles.bar} data-stub="Kbd" data-variant="bar" data-held={held || undefined}>
        {items.map((it) => (
          <span key={it.label} className={styles.item} data-item="" data-more={it.more || undefined}>
            <span className={styles.caps}>
              {it.keys.map((k, i) => (
                <kbd key={`${k}${i}`} className={styles.kbd} data-size={size} data-hud={hud || undefined} data-cjk={cjk(k)}>
                  {k}
                </kbd>
              ))}
            </span>
            {it.label}
          </span>
        ))}
      </span>
    );
  return (
    <kbd className={styles.kbd} data-stub="Kbd" data-size={size} data-hud={hud || undefined} data-cjk={cjk(children)}>
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
  {
    name: 'bar',
    props: {
      variant: 'bar',
      items: [
        { keys: ['Q', 'E'], label: '切页签' },
        { keys: ['1', '5'], label: '直达页签' },
        { keys: ['Space'], label: '暂停', more: true },
        { keys: ['esc'], label: '主页' },
      ],
    },
  },
  { name: 'bar-chord', props: { variant: 'bar', items: [{ keys: ['⌘', '⇧', 'K'], label: '命令面板' }, { keys: ['↑', '↓'], label: '选择' }, { keys: ['⏎'], label: '打开' }] } },
];
