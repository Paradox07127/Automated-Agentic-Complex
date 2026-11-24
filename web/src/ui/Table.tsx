import { Children, createContext, isValidElement, useContext, type KeyboardEvent, type ReactNode } from 'react';
import { IconBtn } from './IconBtn';
import { useControlled } from './useControlled';
import styles from './Table.module.css';

/** 表格：粘性表头，数字列 tnum 右对齐；↑↓ 选行，↵ 打开，行尾固定 ⋯ 插槽。 */
export interface TableProps {
  /** 读屏名称 */
  label: string;
  /** 表头，放一个 TableHead */
  head: ReactNode;
  /** 各行，放 TableRow */
  children: ReactNode;
  /** 选中行的 id */
  selected?: string | null;
  /** 点击或 ↑↓ 选中一行 */
  onSelect?: (id: string) => void;
  /** 在选中行上按 ↵ */
  onOpen?: (id: string) => void;
  /** 表格自己滚动时的最大高度（px）；不给时随外层容器滚动，表头粘在外层顶部 */
  maxHeight?: number | string;
}

/** 表头行：放 head 的 TableCell；行尾有 ⋯ 列时给 menu。 */
export interface TableHeadProps {
  children: ReactNode;
  /** 为行尾 ⋯ 留一列 */
  menu?: boolean;
}

/** 一行；id 用于选中和打开。 */
export interface TableRowProps {
  id: string;
  children: ReactNode;
  /** 行尾 ⋯ 插槽，通常是一个打开菜单的 IconBtn */
  menu?: ReactNode;
}

/** 单元格：head 时是列标题，num 时用 tnum 右对齐，mono 时用等宽字。 */
export interface TableCellProps {
  children?: ReactNode;
  head?: boolean;
  num?: boolean;
  mono?: boolean;
}

interface RowState {
  selected: string | null;
  /** The row Tab lands on: the selected one, else the first. */
  tabStop: string | null;
  select: (id: string) => void;
}

const RowCtx = createContext<RowState>({ selected: null, tabStop: null, select: () => undefined });

export function Table({ label, head, children, selected = null, onSelect, onOpen, maxHeight }: TableProps) {
  const [current, select] = useControlled<string | null>(selected, onSelect as ((id: string | null) => void) | undefined);
  const ids = Children.toArray(children).flatMap((c) => (isValidElement<{ id?: string }>(c) && c.props.id != null ? [c.props.id] : []));
  // A selection none of these rows has (a sibling table's) must not take the Tab stop from them.
  const tabStop = current != null && ids.includes(current) ? current : (ids[0] ?? null);

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const row = e.target instanceof HTMLTableRowElement ? e.target : null;
    if (!row?.dataset.rowId) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen?.(row.dataset.rowId);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]'));
    const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next?.dataset.rowId) return;
    next.focus();
    select(next.dataset.rowId);
  };

  return (
    <div className={styles.wrap} data-stub="Table" data-scroll={maxHeight ? '' : undefined} style={maxHeight ? { maxHeight } : undefined}>
      <RowCtx.Provider value={{ selected: current, tabStop, select: (id) => select(id) }}>
        <table className={styles.table} role="grid" aria-label={label}>
          {head}
          <tbody onKeyDown={onKeyDown}>{children}</tbody>
        </table>
      </RowCtx.Provider>
    </div>
  );
}

export function TableHead({ children, menu }: TableHeadProps) {
  return (
    <thead>
      <tr>
        {children}
        {menu && <th className={styles.menu} aria-label="操作" />}
      </tr>
    </thead>
  );
}

export function TableRow({ id, children, menu }: TableRowProps) {
  const { selected, tabStop, select } = useContext(RowCtx);
  const isSel = selected === id;
  return (
    <tr
      className={styles.row}
      data-row-id={id}
      aria-selected={isSel}
      tabIndex={tabStop === id ? 0 : -1}
      onClick={() => select(id)}
    >
      {children}
      {menu !== undefined && <td className={styles.menu}>{menu}</td>}
    </tr>
  );
}

export function TableCell({ children, head, num, mono }: TableCellProps) {
  const Tag = head ? 'th' : 'td';
  return (
    <Tag className={styles.cell} scope={head ? 'col' : undefined} data-num={num || undefined} data-mono={mono || undefined}>
      {children}
    </Tag>
  );
}

const RUNS = [
  { id: 'r1', task: '汇总 10 月开销表', state: '进行中', turns: 14, tokens: '38,210', dur: '18:02' },
  { id: 'r2', task: '整理本周提交说明', state: '完成', turns: 6, tokens: '9,884', dur: '3:41' },
  { id: 'r3', task: '检查发票重复项', state: '失败', turns: 3, tokens: '2,107', dur: '0:52' },
  { id: 'r4', task: '更新家庭预算模板', state: '完成', turns: 9, tokens: '15,330', dur: '7:15' },
  { id: 'r5', task: '下载银行流水', state: '待处理', turns: 2, tokens: '1,046', dur: '0:31' },
  { id: 'r6', task: '归档 9 月收据', state: '完成', turns: 5, tokens: '6,412', dur: '2:58' },
  { id: 'r7', task: '对比两份报价单', state: '完成', turns: 7, tokens: '11,905', dur: '5:20' },
  { id: 'r8', task: '提醒续费域名', state: '取消', turns: 1, tokens: '388', dur: '0:09' },
];

const runTable = (count: number, menu: boolean) => ({
  label: '运行记录',
  head: (
    <TableHead menu={menu}>
      <TableCell head>任务</TableCell>
      <TableCell head>状态</TableCell>
      <TableCell head num>
        轮次
      </TableCell>
      <TableCell head num>
        tokens
      </TableCell>
      <TableCell head num>
        用时
      </TableCell>
    </TableHead>
  ),
  children: RUNS.slice(0, count).map((r) => (
    <TableRow key={r.id} id={r.id} menu={menu ? <IconBtn icon="more" label={`${r.task}的更多操作`} size="sm" /> : undefined}>
      <TableCell>{r.task}</TableCell>
      <TableCell>{r.state}</TableCell>
      <TableCell num>{r.turns}</TableCell>
      <TableCell num>{r.tokens}</TableCell>
      <TableCell num>{r.dur}</TableCell>
    </TableRow>
  )),
});

export const TableDemos: Array<{ name: string; props: TableProps }> = [
  { name: 'runs', props: { ...runTable(5, true), selected: 'r2' } },
  { name: 'sticky', props: { ...runTable(8, true), maxHeight: 200 } },
  { name: 'plain', props: runTable(3, false) },
];
