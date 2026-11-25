import { formatMs, type ToolItem } from '../../domain';
import { BarList, type BarListRow } from '../../charts';
import { InfoTip } from '../../ui';
import { toolFamily } from './waterfall';
import styles from './ToolDist.module.css';

/** 工具耗时分布：Top 6 + 其他，「总耗时 · 次数」；点一个工具，瀑布只高亮它。 */
export interface ToolDistProps {
  /** 工具调用 */
  tools: ToolItem[];
  /** 当前时间（进行中的调用算到现在） */
  now: number;
  /** 选中的工具族 */
  selected?: string | null;
  /** 点工具；再点一次清除 */
  onPick?: (family: string | null) => void;
}

export function toolRows(tools: readonly ToolItem[], now: number): BarListRow[] {
  const by = new Map<string, { ms: number; n: number }>();
  for (const it of tools) {
    const k = toolFamily(it.name);
    const g = by.get(k) ?? { ms: 0, n: 0 };
    g.ms += (it.updated_at ?? now) - it.created_at;
    g.n += 1;
    by.set(k, g);
  }
  return [...by.entries()].map(([k, g]) => ({ key: k, label: k, value: g.ms, readout: `${formatMs(g.ms)} │ ${g.n} 次` }));
}

export function ToolDist({ tools, now, selected = null, onPick }: ToolDistProps) {
  return (
    <div data-stub="ToolDist" className={styles.root}>
      {tools.length === 0 ? (
        <p className={styles.note}>没有调用工具。</p>
      ) : (
        <BarList rows={toolRows(tools, now)} label="工具耗时" top={6} otherReadout={formatMs} selected={selected} onPick={(k) => onPick?.(k === selected ? null : k)} />
      )}
      <p className={styles.note}>
        <InfoTip>点击某个工具后，上方瀑布图仅高亮该工具的调用刻度</InfoTip>
      </p>
    </div>
  );
}
