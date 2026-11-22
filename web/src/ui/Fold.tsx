import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SecHead, type SecHeadProps } from './SecHead';
import styles from './Fold.module.css';

/**
 * 折叠段：上下细线间一行，旋转箭头 + 标签 + 计数 + 收起时的一行摘要，默认收起；里面有出错或等你处理的条目时自动打开。
 * 内容不超过 3 行时直接摊开、不给折叠键。Enter / 空格切换，→ 展开，← 收起；Esc 不管折叠。
 */
export interface FoldProps {
  /** 给了就按「页面 + id」把开合记在 sessionStorage（本次运行内有效） */
  id?: string;
  /** 标签 */
  label: string;
  /** 标签后的计数 */
  count?: number;
  /** 收起时标签后的一行摘要 */
  summary?: ReactNode;
  /** 默认展开 */
  defaultOpen?: boolean;
  /** 有出错或等你处理的条目：打开，之后变成 true 时也打开 */
  autoOpen?: boolean;
  /** 内容的行数；不超过 3 行时直接摊开，没有折叠键 */
  rows?: number;
  /** 标题行右端的操作，不跟着开合 */
  right?: ReactNode;
  /** head：分组标题（SecHead 的样子）当折叠头 */
  variant?: 'row' | 'head';
  /** head 变体：编号、状态点、右端微型英文 */
  head?: Pick<SecHeadProps, 'no' | 'tone' | 'micro'>;
  /** 展开后的内容 */
  children: ReactNode;
}

/** Most rows a fold shows without a toggle (the game's MissionHudCtrl folds only what does not fit). */
const FLAT_ROWS = 3;
const KEY = 'ef.fold:';

/** The page a fold belongs to: the hash route (main window) or the document (desktop surfaces). */
const pageKey = () => (location.hash.replace(/^#/, '').split('?')[0] || location.pathname) + ':';

function recall(id: string): boolean | undefined {
  try {
    const v = sessionStorage.getItem(KEY + pageKey() + id);
    return v == null ? undefined : v === '1';
  } catch {
    return undefined;
  }
}

function remember(id: string, open: boolean) {
  try {
    sessionStorage.setItem(KEY + pageKey() + id, open ? '1' : '0');
  } catch {
    // Storage refused (private mode, quota): the fold still toggles, it just is not remembered.
  }
}

export function Fold({ id, label, count, summary, defaultOpen = false, autoOpen = false, rows, right, variant = 'row', head, children }: FoldProps) {
  const [open, setOpen] = useState(() => autoOpen || ((id ? recall(id) : undefined) ?? defaultOpen));
  const [wasAuto, setWasAuto] = useState(autoOpen);
  if (wasAuto !== autoOpen) {
    setWasAuto(autoOpen);
    if (autoOpen) setOpen(true);
  }
  const bodyId = useId();
  const flat = rows != null && rows <= FLAT_ROWS;
  const set = (next: boolean) => {
    if (next === open) return;
    if (id) remember(id, next);
    setOpen(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = e.key === 'ArrowRight' ? true : e.key === 'ArrowLeft' ? false : null;
    if (next == null) return;
    e.preventDefault();
    set(next);
  };
  const shown = flat || open;
  const chev = (
    <svg className={styles.chev} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
  const toggle = flat
    ? undefined
    : { open, bodyId, chev, summary: open ? undefined : summary, onToggle: () => set(!open), onKeyDown };

  if (variant === 'head')
    return (
      <section className={styles.sec} data-stub="Fold" data-variant="head" data-open={shown || undefined} aria-label={label}>
        <SecHead title={label} count={count} right={right} {...head} fold={toggle} />
        {shown && (
          <div id={bodyId} className={styles.secBody}>
            {children}
          </div>
        )}
      </section>
    );

  const inner = (
    <>
      <span className={styles.label}>{label}</span>
      {count != null && <span className={`${styles.count} num`}>{count}</span>}
      {!shown && summary != null && <span className={styles.summary}>{summary}</span>}
    </>
  );
  return (
    <div className={styles.fold} data-stub="Fold" data-open={shown || undefined}>
      <div className={styles.line}>
        {toggle ? (
          <button type="button" className={styles.head} aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggle.onToggle} onKeyDown={onKeyDown}>
            {chev}
            {inner}
          </button>
        ) : (
          <span className={styles.head} data-flat="">
            {inner}
          </span>
        )}
        {right != null && <span className={styles.right}>{right}</span>}
      </div>
      {shown && (
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
      )}
    </div>
  );
}

const list = (n: number) => (
  <>
    {Array.from({ length: n }, (_, i) => (
      <span key={i}>第 {i + 1} 条：整理本周提交周报</span>
    ))}
  </>
);

export const FoldDemos: Array<{ name: string; props: FoldProps }> = [
  { name: 'closed', props: { label: '做完了', count: 6, summary: '最近：生成 Metal 渲染基准报告 11:02', rows: 6, children: list(6) } },
  { name: 'auto-open', props: { label: '出错的', count: 4, autoOpen: true, rows: 4, children: list(4) } },
  { name: 'flat', props: { label: '提醒', count: 2, rows: 2, children: list(2) } },
  { name: 'right', props: { label: '原始记录', count: 12, summary: '12 行', rows: 12, right: '只存本机', children: list(5) } },
  { name: 'head', props: { variant: 'head', label: '前一天的观察日报', count: 3, summary: '看到 1 │ 卡住 1 │ 建议 1', rows: 8, head: { micro: 'Daily Report' }, children: list(8) } },
  { name: 'head-open', props: { variant: 'head', label: '进行中', count: 4, defaultOpen: true, rows: 4, head: { tone: 'running', micro: 'Running' }, children: list(4) } },
];
