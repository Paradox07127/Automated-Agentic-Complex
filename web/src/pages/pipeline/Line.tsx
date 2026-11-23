import type { ReactNode } from 'react';
import type { IconName } from '../../ui';
import { AlertTip, GameFrame, StationCard } from '../../ui/game';
import { StateGlyph } from '../../ui/game/StateGlyph';
import { stateVisual } from '../../domain/status';
import { Belt, MergeBelt } from './Belt';
import { belts, PHASE, type Phase, type StationId, type States } from './model';
import { useNarrow } from './narrow';
import styles from './Line.module.css';

export const NAME: Readonly<Record<StationId, { no: string; micro: string; name: string; icon: IconName }>> = {
  obs: { no: '01', micro: 'OBSERVE', name: '观察', icon: 'look' },
  interp: { no: '02', micro: 'INTERPRET', name: '理解', icon: 'kernel' },
  mem: { no: '03', micro: 'CONSOLIDATE', name: '整理', icon: 'data' },
  store: { no: '04', micro: 'MEMORY', name: '记忆库', icon: 'hub' },
};

/** What a station card shows besides its name and state. */
export interface CardRead {
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  sub?: ReactNode;
}

export interface LineProps {
  states: States;
  cards: Readonly<Record<StationId, CardRead>>;
  selected: StationId;
  onSelect: (k: StationId) => void;
  /** Belts that march: into 理解 while requests wait, into 整理 while a batch runs. */
  flow: { obs: boolean; mem: boolean };
  /** 后台断开：产线褪色、带子不走。 */
  stale: boolean;
  alert: { at: StationId; text: ReactNode; onClick: () => void } | null;
}

/** Shapes and words of the legend; 堵住 and 已暂停 drop out on a narrow window. */
const LEGEND: Array<[Phase, boolean]> = [
  ['run', false],
  ['idle', false],
  ['block', true],
  ['fail', false],
  ['pause', true],
];

function Legend() {
  return (
    <span className={styles.legend}>
      {LEGEND.map(([p, opt]) => (
        <span key={p} className={styles.sign} data-opt={opt || undefined}>
          <StateGlyph shape={stateVisual(PHASE[p].key).shape} />
          {PHASE[p].label}
        </span>
      ))}
    </span>
  );
}

/** 产线：观察 → 理解 → 整理 → 记忆库四个工位卡，中间是传送带；工位就是这页的选择器。 */
export function Line({ states, cards, selected, onSelect, flow, stale, alert }: LineProps) {
  const [b1, b2, b3] = belts(states, stale);
  const compact = useNarrow();
  const card = (k: StationId) => {
    const s = states[k];
    return (
      <div className={styles.cell} data-sel={selected === k || undefined} data-k={k}>
        <StationCard
          tab
          {...NAME[k]}
          {...cards[k]}
          state={PHASE[s.phase].key}
          stateLabel={PHASE[s.phase].label}
          why={s.why ?? undefined}
          selected={selected === k}
          compact={compact}
          onSelect={() => onSelect(k)}
        />
        {alert?.at === k && (
          <span className={styles.alert} data-at={k}>
            <AlertTip label={`出事的工位：${NAME[k].name}`} pointAt={k === 'obs' ? '50cqw' : k === 'store' ? 'calc(100% - 50cqw)' : undefined} onClick={alert.onClick}>
              {alert.text}
            </AlertTip>
          </span>
        )}
      </div>
    );
  };
  return (
    <GameFrame title="产线" micro="OBSERVE → MEMORY / TODAY" label="产线">
      <div className={styles.frame}>
        <div className={styles.head}>
          <span className={styles.rule} aria-hidden="true" />
          <Legend />
        </div>
        <div className={styles.row} role="tablist" aria-label="工位" data-stale={stale || undefined}>
          {card('obs')}
          <Belt label="请求" flow={!stale && flow.obs} tone={b1} />
          {card('interp')}
          <MergeBelt flow={!stale && flow.mem} tone={b2} />
          {card('mem')}
          <Belt label="写入" flow={false} tone={b3} />
          {card('store')}
        </div>
      </div>
    </GameFrame>
  );
}
