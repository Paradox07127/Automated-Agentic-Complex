import type { ReactNode } from 'react';
import { useControlled } from './useControlled';
import styles from './SecHead.module.css';

/** 编号节头（开放区）：编号、标题、[n] 计数，有语义时一个方形状态点，其后一条斜纹带延伸到右端的操作或折叠钮。diag 变体同样是普通标题。 */
export interface SecHeadProps {
  /** 标题 */
  title: string;
  /** 编号，例如 01（装饰，读屏跳过） */
  no?: string;
  /** 计数 */
  count?: number;
  /** 状态点的语义色，默认 none（不画点） */
  tone?: 'waiting' | 'running' | 'failed' | 'ok' | 'none';
  /** 右侧操作 */
  right?: ReactNode;
  /** 折叠态；给了才显示折叠钮 */
  collapsed?: boolean;
  /** 折叠切换 */
  onToggle?: () => void;
  /** 诊断页分组头，默认 band；两者外观相同 */
  variant?: 'band' | 'diag';
}

export function SecHead({ title, no, count, tone = 'none', right, collapsed, onToggle, variant = 'band' }: SecHeadProps) {
  const [folded, setFolded] = useControlled(!!collapsed, onToggle && (() => onToggle()));
  return (
    <div className={styles.head} data-stub="SecHead" data-tone={tone} data-variant={variant}>
      {no && (
        <span className={styles.no} aria-hidden="true">
          {no}
        </span>
      )}
      {tone !== 'none' && <span className={styles.dot} data-dot={tone} />}
      <h3 className={styles.title}>{title}</h3>
      {count != null && (
        <span className={styles.count}>
          <span aria-hidden="true">[</span>
          {count}
          <span aria-hidden="true">]</span>
        </span>
      )}
      <span className={styles.right}>{right}</span>
      {collapsed != null && (
        <button
          type="button"
          className={styles.fold}
          aria-expanded={!folded}
          aria-label={`${folded ? '展开' : '收起'}「${title}」`}
          onClick={() => setFolded(!folded)}
        >
          {folded ? '展开' : '收起'}
          <span aria-hidden="true">{folded ? '▾' : '▴'}</span>
        </button>
      )}
    </div>
  );
}

export const SecHeadDemos: Array<{ name: string; props: SecHeadProps }> = [
  { name: 'numbered', props: { no: '01', title: '今日简报', right: '09:00–15:30' } },
  { name: 'waiting', props: { title: '待处理', count: 3, tone: 'waiting' } },
  { name: 'running', props: { title: '进行中', count: 2, tone: 'running', collapsed: false } },
  { name: 'failed', props: { title: '出错', count: 1, tone: 'failed' } },
  { name: 'collapsible', props: { title: '已完成', count: 12, tone: 'ok', collapsed: true } },
  { name: 'plain', props: { title: '其他', right: '按时间排序' } },
  { name: 'diag', props: { variant: 'diag', title: '进程', tone: 'ok', right: '4 个 │ 0 个不正常' } },
  { name: 'diag-failed', props: { variant: 'diag', title: '进程', tone: 'failed', right: '4 个 │ 1 个不正常' } },
];
