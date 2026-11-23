import styles from './CountBadge.module.css';

/** 角标：数字为红色胶囊（square 为红色方块），纯提醒为橙色菱形红点，新内容为黄色 NEW 签，ink 是压在黄色选中块上的墨色方块数字；为 0 时不渲染。 */
export interface CountBadgeProps {
  /** 数量 */
  count: number;
  /** 读屏前缀，例如「等你」 */
  label?: string;
  /** 数字胶囊 / 不带数字的红点 / NEW 签 / 红色方块数字（图上的节点、格子）/ 黄块上的墨色方块数字，默认 number */
  kind?: 'number' | 'dot' | 'new' | 'square' | 'ink';
}

export function CountBadge({ count, label, kind = 'number' }: CountBadgeProps) {
  if (count <= 0) return null;
  const named = label ? `${label} ${kind === 'new' ? 'NEW' : count}` : undefined;
  if (kind === 'dot') return <span className={styles.dot} data-stub="CountBadge" data-kind={kind} role="img" aria-label={named ?? String(count)} />;
  return (
    <span className={styles.badge} data-stub="CountBadge" data-kind={kind} role={label ? 'img' : undefined} aria-label={named}>
      {kind === 'new' ? 'NEW' : count > 99 ? '99+' : count}
    </span>
  );
}

export const CountBadgeDemos: Array<{ name: string; props: CountBadgeProps }> = [
  { name: 'default', props: { count: 3, label: '待处理' } },
  { name: 'wide', props: { count: 128, label: '未读' } },
  { name: 'dot', props: { count: 1, label: '有更新', kind: 'dot' } },
  { name: 'new', props: { count: 1, label: '新版本', kind: 'new' } },
  { name: 'square', props: { count: 4, label: '出错', kind: 'square' } },
  { name: 'ink', props: { count: 2, label: '待确认', kind: 'ink' } },
];
