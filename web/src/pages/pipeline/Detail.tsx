import type { CSSProperties, ReactNode } from 'react';
import { Empty, InfoTip, type IconName } from '../../ui';
import { Barcode, GameFrame, MicroLabel, ReadTick, StatusLamp, type ReadTickProps } from '../../ui/game';
import { NAME } from './Line';
import { PHASE, type StationId, type StationState } from './model';
import { useNarrow } from './narrow';
import styles from './Detail.module.css';

/** 每个工位一句话讲清这一段做什么。 */
const DESC: Readonly<Record<StationId, string>> = {
  obs: '她看屏幕和窗口文字的请求；截图有每日额度',
  interp: '把看到的东西读成当前活动和任务推断；结果进本轮上下文和观察记录',
  mem: '把对话、后台任务结果和观察记录提炼成记忆；约每 2 分钟看一次有没有新来源',
  store: '整理写进来的记忆；条目、确认和删除在记忆页',
};

/** 详情头带：主题色双竖条、编号大字、名字和一句说明、状态、条码带。 */
export function DetailHead({ k, state }: { k: StationId; state: StationState }) {
  const n = NAME[k];
  const p = PHASE[state.phase];
  return (
    <header className={styles.head} data-phase={state.phase}>
      <span className={styles.bars} aria-hidden="true">
        <i />
        <i />
      </span>
      <span className={styles.no}>
        <MicroLabel>{n.micro}</MicroLabel>
        <b className="num" aria-hidden="true">
          {n.no}
        </b>
      </span>
      <span className={styles.title}>
        <h2>{n.name}</h2>
        <small>{DESC[k]}</small>
      </span>
      <span className={styles.state}>
        <StatusLamp state={p.key} label={`${p.label}${state.why ? ` │ ${state.why}` : ''}`} />
      </span>
      <span className={styles.band} aria-hidden="true">
        <MicroLabel>STATION // LOCAL ONLY</MicroLabel>
        <Barcode width={188} height={20} />
      </span>
    </header>
  );
}

export interface ReadCell extends Omit<ReadTickProps, 'size'> {
  /** 窄窗收起 */
  opt?: boolean;
}

/** 读数带：一排同级读数，竖条 + 大数 + 小字；出错红、满额橙。窄窗里小字跟在数后面，读数带只占一行。 */
export function Reads({ cells }: { cells: readonly ReadCell[] }) {
  const narrow = useNarrow();
  return (
    <div className={styles.reads} style={{ '--n': cells.length, '--n-sm': cells.filter((c) => !c.opt).length } as CSSProperties}>
      {cells.map(({ opt, ...c }, i) => (
        <span key={i} className={styles.read} data-opt={opt || undefined}>
          <ReadTick size="lg" inline={narrow} {...c} />
        </span>
      ))}
    </div>
  );
}

/** 详情里的一块：GameFrame 的标题牌（名字和条数），口径说明收进 ⓘ。 */
export function Panel({ title, count, tip, micro, children }: { title: string; count?: number; tip?: string; micro?: string; children: ReactNode }) {
  return (
    <GameFrame
      label={title}
      micro={micro}
      title={
        <>
          {title}
          {count != null && <span className="num">{count}</span>}
        </>
      }
    >
      <div className={styles.panel}>
        {tip && (
          <span className={styles.tip}>
            <InfoTip>{tip}</InfoTip>
          </span>
        )}
        {children}
      </div>
    </GameFrame>
  );
}

/** 没有数据：一行原因加一个动作。 */
export function None({ title, desc, icon, action }: { title: string; desc?: string; icon?: IconName; action?: ReactNode }) {
  return (
    <div className={styles.none}>
      <Empty title={title} desc={desc} icon={icon} action={action} />
    </div>
  );
}
