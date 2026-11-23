import { useState, type CSSProperties, type ReactNode } from 'react';
import { ExpandRow, InTable } from './ExpandRow';
import styles from './GameTable.module.css';

/** 统计表（游戏 fachub 数据面板）：26 高浅底表头 + 12 px 列名；行用 ExpandRow（38 高、选中黄左条、出错红底），可展开；窄窗收起 opt 列。 */
export interface GameTableProps {
  /** 读屏名称 */
  label: string;
  /** 列：名称和 CSS 宽度（`56px`、`minmax(0,1fr)`）；opt 的列在窗口窄于 1100 时收起 */
  columns: GameTableColumn[];
  /** 行尾操作那一列的宽度，默认 auto */
  endWidth?: string;
  rows: GameTableRow[];
  /** 选中的行 id */
  selected?: string | null;
  /** 点一行（开合之外顺带选中） */
  onSelect?: (id: string) => void;
  /** 受控：展开的行 id；给了就不看各行的 defaultOpen */
  expanded?: readonly string[];
  /** 开合一行后要展开的行 id */
  onExpandedChange?: (ids: string[]) => void;
}

export interface GameTableColumn {
  key: string;
  label: string;
  width: string;
  opt?: boolean;
}

export interface GameTableRow {
  id: string;
  /** 按列给的格子，键同列的 key */
  cells: Record<string, ReactNode>;
  /** 展开体 */
  body?: ReactNode;
  /** 行尾操作 */
  end?: ReactNode;
  tone?: 'fail' | 'run';
  /** 初始展开（出错的、等你处理的） */
  defaultOpen?: boolean;
}

export function GameTable({ label, columns, endWidth = 'auto', rows, selected = null, onSelect, expanded, onExpandedChange }: GameTableProps) {
  const [inner, setInner] = useState(() => new Set(rows.filter((r) => r.defaultOpen).map((r) => r.id)));
  const open = expanded ? new Set(expanded) : inner;
  const grid = {
    '--gt-wide': columns.map((c) => c.width).join(' '),
    '--gt-narrow': columns.filter((c) => !c.opt).map((c) => c.width).join(' '),
    '--gt-end': endWidth,
  } as CSSProperties;
  const toggle = (id: string, next: boolean) => {
    onSelect?.(id);
    const n = new Set(open);
    if (next) n.add(id);
    else n.delete(id);
    if (!expanded) setInner(n);
    onExpandedChange?.([...n]);
  };
  return (
    <div className={styles.table} data-stub="GameTable" role="group" aria-label={label} style={grid}>
      <div className={styles.head}>
        <span />
        {columns.map((c) => (
          <span key={c.key} data-opt={c.opt || undefined}>
            {c.label}
          </span>
        ))}
        <span />
      </div>
      <InTable.Provider value={true}>
        {rows.map((r) => (
          <ExpandRow
            key={r.id}
            open={open.has(r.id)}
            onToggle={(next) => toggle(r.id, next)}
            body={r.body}
            end={r.end}
            tone={r.tone}
            selected={selected === r.id}
          >
            {columns.map((c) => (
              <span key={c.key} data-opt={c.opt || undefined}>
                {r.cells[c.key]}
              </span>
            ))}
          </ExpandRow>
        ))}
      </InTable.Provider>
    </div>
  );
}

const COLS: GameTableColumn[] = [
  { key: 'at', label: '时间', width: '56px' },
  { key: 'use', label: '用途', width: '72px' },
  { key: 'res', label: '结果', width: '96px' },
  { key: 'what', label: '写了什么', width: 'minmax(0, 1fr)' },
  { key: 'ms', label: '用时', width: '64px', opt: true },
  { key: 'model', label: '模型', width: 'minmax(80px, 0.6fr)', opt: true },
];

const ROWS: GameTableRow[] = [
  { id: 'r3', tone: 'run', cells: { at: '14:10', use: '后台整理', res: '进行中', what: '正在读 7 条来源…', ms: '—', model: 'gpt-5.5-mini' } },
  {
    id: 'r2',
    tone: 'fail',
    defaultOpen: true,
    cells: { at: '13:40', use: '后台整理', res: '校验没通过', what: '模型返回的条目缺少来源', ms: '12 s', model: 'gpt-5.5-mini' },
    body: '模型返回的 3 条里有 1 条没有来源，整批没有写入。',
    end: '生成记录 ›',
  },
  {
    id: 'r1',
    cells: { at: '13:12', use: '对话中', res: '已写入', what: '+3 新增 ～1 更新', ms: '8 s', model: 'gpt-5.5-mini' },
    body: '新增：喜欢在周五下午整理周报',
    end: '生成记录 ›',
  },
];

export const GameTableDemos: Array<{ name: string; props: GameTableProps }> = [
  { name: 'records', props: { label: '整理记录', columns: COLS, rows: ROWS, endWidth: '76px', selected: 'r1' } },
];
