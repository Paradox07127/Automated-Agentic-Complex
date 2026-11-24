import { createContext, useContext, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import styles from './ExpandRow.module.css';

/**
 * 可展开行：整行是开合键，左端旋转箭头；Enter / 空格切换，→ 展开，← 收起，Esc 不管。出错红底红左条、在跑蓝左条、选中黄左条。
 * 开合不记；出错或等你处理的那行由调用方给 defaultOpen。行尾的操作不跟着开合。
 */
export interface ExpandRowProps {
  /** 行内容；在 GameTable 里是按列排好的格子 */
  children: ReactNode;
  /** 展开体；没有就是一行普通行，不能点开 */
  body?: ReactNode;
  /** 行尾操作（「生成记录 ›」、⋯），不跟着开合 */
  end?: ReactNode;
  /** 受控的开合 */
  open?: boolean;
  /** 不受控时的初始开合 */
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  /** 点了这一行（有没有展开体都算），开合之前 */
  onActivate?: () => void;
  /** fail：红底红左条；run：蓝左条 */
  tone?: 'fail' | 'run';
  /** 选中：黄左条 */
  selected?: boolean;
  /** 读屏名称；不给就读行里的字 */
  label?: string;
}

/** Set by GameTable: its rows lay their cells on the table's columns. */
export const InTable = createContext(false);

export function ExpandRow({ children, body, end, open: openProp, defaultOpen = false, onToggle, onActivate, tone, selected, label }: ExpandRowProps) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const bodyId = useId();
  const table = useContext(InTable);
  const expandable = body != null;
  const set = (next: boolean) => {
    if (next === open) return;
    if (openProp === undefined) setInner(next);
    onToggle?.(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const next = e.key === 'Enter' || e.key === ' ' ? !open : e.key === 'ArrowRight' ? true : e.key === 'ArrowLeft' ? false : null;
    if (next == null) return;
    e.preventDefault();
    onActivate?.();
    set(next);
  };
  const content = (
    <>
      <i className={styles.chev} data-none={expandable ? undefined : ''} aria-hidden="true" />
      {table ? children : <span className={styles.cells}>{children}</span>}
    </>
  );
  return (
    <div className={styles.item} data-stub="ExpandRow" data-tone={tone} data-selected={selected || undefined} data-open={(expandable && open) || undefined}>
      <div className={styles.line}>
        {expandable ? (
          <div role="button" tabIndex={0} className={styles.row} aria-expanded={open} aria-controls={open ? bodyId : undefined} aria-label={label} onClick={() => { onActivate?.(); set(!open); }} onKeyDown={onKeyDown}>
            {content}
          </div>
        ) : (
          <div className={styles.row} onClick={onActivate}>
            {content}
          </div>
        )}
        <span className={styles.end}>{end}</span>
      </div>
      {expandable && open && (
        <div id={bodyId} className={styles.body}>
          {body}
        </div>
      )}
    </div>
  );
}

const cells = (a: string, b: string, c: string) => (
  <>
    <span className="num">{a}</span>
    <span>{b}</span>
    <span>{c}</span>
  </>
);

export const ExpandRowDemos: Array<{ name: string; props: ExpandRowProps }> = [
  { name: 'closed', props: { children: cells('14:02', '后台整理', '+3 新增 ～1 更新'), body: '新增：喜欢在周五下午整理周报' } },
  { name: 'failed-open', props: { tone: 'fail', defaultOpen: true, children: cells('13:40', '后台整理', '校验没通过'), body: '模型返回的条目缺少来源' } },
  { name: 'selected', props: { selected: true, children: cells('13:12', '对话中', '无新增'), end: '生成记录 ›' } },
  { name: 'plain', props: { tone: 'run', children: cells('14:10', '后台整理', '正在读 7 条来源…') } },
];
