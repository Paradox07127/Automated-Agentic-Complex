import { useChartLabel } from './ChartLabel';
import common from './chart.module.css';
import palette from './palette.module.css';
import styles from './BarList.module.css';

export interface BarListRow {
  key: string;
  label: string;
  value: number;
  /** Text after the bar; defaults to the value. */
  readout?: string;
}

/** 横条排行：单系列，按值降序取 Top N，其余合并「其他」；条右直接标数值。 */
export interface BarListProps {
  /** 行（未排序也可） */
  rows: BarListRow[];
  /** 图名（读屏标题）；有 onPick 时是按钮列表的名称，否则整张图是 role=img */
  label: string;
  /** 保留前 N 行，其余并入「其他」，默认 3 */
  top?: number;
  /** 系列色：muted 墨色 2 级（默认），s1 墨色 1 级 */
  series?: 's1' | 'muted';
  /** 高亮的行 key */
  selected?: string | null;
  /** 点行 */
  onPick?: (key: string) => void;
  /** 「其他」行的读数（带单位）；默认裸数值 */
  otherReadout?: (value: number) => string;
  /** 要强调的行 key：条用强调色 */
  emph?: string;
}

export const OTHER_KEY = '__other';

/** Label column fits about this many half-width characters (64 px at 12 px); CJK counts 2. */
const LABEL_UNITS = 10;
const unit = (c: string) => ((c.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1);

/** Shortens a long label in the middle, so both a host's start and its domain stay readable. */
export function midEllipsis(text: string, max = LABEL_UNITS): string {
  const chars = [...text];
  if (chars.reduce((n, c) => n + unit(c), 0) <= max) return text;
  const half = (max - 2) / 2;
  let head = '';
  let tail = '';
  for (let i = 0, w = 0; i < chars.length && w + unit(chars[i]!) <= half; w += unit(chars[i]!), i++) head += chars[i];
  for (let i = chars.length - 1, w = 0; i >= 0 && w + unit(chars[i]!) <= half; w += unit(chars[i]!), i--) tail = chars[i] + tail;
  return `${head}…${tail}`;
}

/** Rows as drawn: descending, top N, the rest merged into 「其他」 (with the merged names). */
export function barListRows(rows: ReadonlyArray<BarListRow>, top: number, otherReadout?: (value: number) => string): Array<BarListRow & { merged?: string[] }> {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const rest = sorted.slice(top);
  if (rest.length === 0) return sorted;
  const value = rest.reduce((n, r) => n + r.value, 0);
  return [...sorted.slice(0, top), { key: OTHER_KEY, label: '其他', value, readout: otherReadout?.(value), merged: rest.map((r) => r.label) }];
}

export function BarList({ rows, label, top = 3, series = 'muted', selected = null, onPick, otherReadout, emph }: BarListProps) {
  const shown = barListRows(rows, top, otherReadout);
  const max = Math.max(0, ...shown.map((r) => r.value));
  const lbl = useChartLabel(label, shown.map((r) => `${r.label} ${r.readout ?? r.value}`).join('，'));
  if (shown.length === 0) {
    return (
      <div data-stub="BarList" data-series={series} data-empty="" className={styles.root}>
        <p className={common.emptyLine}>{label}：没有可排行的数据</p>
      </div>
    );
  }
  // Rows with buttons stay a labelled list: role=img would hide the buttons from assistive tech.
  const named = onPick ? { 'aria-labelledby': lbl.img['aria-labelledby'], 'aria-describedby': lbl.img['aria-describedby'] } : lbl.img;
  return (
    <>
      {lbl.text}
      <ol data-stub="BarList" data-series={series} className={`${palette.palette} ${styles.root}`} {...named}>
        {shown.map((r) => {
          const other = r.key === OTHER_KEY;
          const w = max > 0 ? Math.max(0, r.value) / max : 0;
          const readout = r.readout ?? String(r.value);
          const tip = other && r.merged ? `其他：${r.merged.slice(0, 6).join('、')}${r.merged.length > 6 ? ' 等' : ''}` : undefined;
          const body = (
            <>
              <span className={styles.label} title={r.label}>
                {midEllipsis(r.label)}
              </span>
              <span className={styles.track} aria-hidden="true">
                <i style={{ width: `${w * 100}%` }} />
              </span>
              <span className={styles.value}>{readout}</span>
            </>
          );
          return (
            <li key={r.key} aria-current={r.key === selected || undefined} data-value={r.value} data-other={other || undefined} data-dim={(selected != null && r.key !== selected) || undefined} data-emph={r.key === emph || undefined} className={`${styles.row} ${common.tip}`} data-tip={tip}>
              {onPick && !other ? (
                <button type="button" className={styles.btn} aria-label={`${r.label} ${readout}`} onClick={() => onPick(r.key)}>
                  {body}
                </button>
              ) : (
                <span className={styles.btn}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

export const BarListDemos: Array<{ name: string; props: BarListProps }> = [
  { name: 'usage', props: { label: '今日调用', rows: [{ key: 'mouth', label: '对话回复', value: 840, readout: '840 k' }, { key: 'agent', label: '角色运行', value: 250, readout: '250 k' }, { key: 'obs', label: '观察摘要', value: 100, readout: '100 k' }, { key: 'dec', label: '动作决策', value: 50, readout: '50 k' }] } },
  { name: 'tools', props: { label: '工具耗时', top: 6, series: 's1', selected: 'write', onPick: () => undefined, rows: [{ key: 'bash', label: 'Bash', value: 41, readout: '41 s │ 3 次' }, { key: 'write', label: 'Write', value: 6, readout: '6 s │ 2 次' }, { key: 'read', label: 'Read', value: 9, readout: '9 s │ 4 次' }] } },
  { name: 'emph', props: { label: '今日调用', emph: 'agent', rows: [{ key: 'mouth', label: '对话回复', value: 840, readout: '840 k' }, { key: 'agent', label: '角色运行', value: 250, readout: '250 k' }, { key: 'obs', label: '观察摘要', value: 100, readout: '100 k' }] } },
  { name: 'zero', props: { label: '今日调用', rows: [{ key: 'a', label: '对话回复', value: 0, readout: '0' }, { key: 'b', label: '角色运行', value: 0, readout: '0' }] } },
  { name: 'many', props: { label: '应用前台时长', top: 4, series: 's1', otherReadout: (m) => `${m} m`, rows: [{ key: 'xc', label: 'Xcode', value: 102, readout: '1 h 42 m' }, { key: 'sf', label: 'Safari', value: 75, readout: '1 h 15 m' }, { key: 'te', label: 'Terminal', value: 48, readout: '48 m' }, { key: 'sl', label: 'Slack', value: 22, readout: '22 m' }, { key: 'mu', label: 'Music', value: 9, readout: '9 m' }, { key: 'pr', label: 'Preview', value: 4, readout: '4 m' }] } },
];
