import type { MemorySource } from '../../domain';
import { Btn } from '../../ui';
import { GameFrame, GameTable, type GameTableRow } from '../../ui/game';
import { md, SRC, SRC_ORDER, sum } from '../memory/model';
import { None, Panel } from './Detail';
import styles from './Views.module.css';

/** Each source in a few words: who it came from. */
const SRC_DESC: Readonly<Record<MemorySource, string>> = {
  asserted_by_user: '你亲口说的',
  observed_context: '从观察整理的',
  confirmed_by_user: '你确认过的推断',
  inferred_hypothesis: '推断、未确认',
};

const COLS = [
  { key: 'src', label: '来源', width: 'minmax(0, 1fr)' },
  { key: 'bar', label: '占比', width: 'minmax(100px, 1.3fr)' },
  { key: 'n', label: '条', width: '36px' },
  { key: 'pct', label: '%', width: '44px' },
];

/** 14 天新增：放大的火花线，今天的点是黄色。 */
function Spark({ pts, since }: { pts: number[]; since: number }) {
  const W = 100;
  const H = 56;
  const mx = Math.max(1, ...pts);
  const y = (v: number) => 4 + (1 - v / mx) * (H - 8);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * W).toFixed(2)} ${y(v).toFixed(2)}`).join('');
  const today = pts.at(-1) ?? 0;
  return (
    <div className={styles.spark} role="img" aria-label={`14 天新增：共 ${sum(pts)} 条，今天 ${today} 条，单日最多 ${mx} 条`}>
      <div className={styles.plot}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={`${d}L${W} ${H}L0 ${H}Z`} className={styles.area} />
          <path d={d} className={styles.line} vectorEffect="non-scaling-stroke" />
        </svg>
        <i className={styles.today} style={{ top: `${(y(today) / H) * 100}%` }} aria-hidden="true" />
      </div>
      <span className={`${styles.axis} num`} aria-hidden="true">
        <span>{md(since)}</span>
        <span>今天</span>
      </span>
    </div>
  );
}

export interface StoreViewProps {
  /** Remembered facts per source (candidates are not memory yet). */
  bySource: Readonly<Record<MemorySource, number>>;
  /** Facts recorded per day, oldest first, today last. */
  added: number[];
  since: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onSource: (key: string) => void;
}

/** 记忆库：记忆从哪来（每一类能去记忆页看），14 天里每天写进来多少。 */
export function StoreView({ bySource, added, since, selected, onSelect, onSource }: StoreViewProps) {
  const total = sum(SRC_ORDER.map((s) => bySource[s]));
  const most = Math.max(1, ...SRC_ORDER.map((s) => bySource[s]));
  const rows: GameTableRow[] = SRC_ORDER.map((s) => ({
    id: s,
    cells: {
      src: (
        <span className={styles.src}>
          <b>{SRC[s].short}</b>
          <span>{SRC_DESC[s]}</span>
        </span>
      ),
      bar: (
        <span className={styles.srcbar} aria-hidden="true">
          <i data-src={SRC[s].key} style={{ width: `${(bySource[s] / most) * 100}%` }} />
        </span>
      ),
      n: <b className={`${styles.right} num`}>{bySource[s]}</b>,
      pct: <span className={`${styles.right} ${styles.dimText} num`}>{total ? Math.round((bySource[s] / total) * 100) : 0}%</span>,
    },
    end: (
      <Btn size="sm" variant="ghost" disabled={bySource[s] === 0} disabledReason="这一类还没有记忆" onClick={() => onSource(SRC[s].key)}>
        去看
      </Btn>
    ),
  }));
  return (
    <div className={styles.cols}>
      <Panel title="按来源" count={total} micro="BY SOURCE">
        {total > 0 ? <GameTable label="按来源" columns={COLS} rows={rows} selected={selected} onSelect={onSelect} /> : <None title="还没有记忆" icon="hub" />}
      </Panel>
      <GameFrame variant="chart" title="14 天新增" micro="ADDED / 14 DAYS" label="14 天新增">
        <div className={styles.chart}>{sum(added) > 0 ? <Spark pts={added} since={since} /> : <None title="14 天里没有新增" icon="hub" />}</div>
      </GameFrame>
    </div>
  );
}
