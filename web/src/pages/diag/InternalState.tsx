import { fromCooldowns, fromTurnNow } from '../../domain/adapt';
import { RawFold } from '../../features/trace';
import { SecHead } from '../../ui';
import { GameFrame, MicroLabel, StatusLamp } from '../../ui/game';
import { GatePanel, gateHolds } from './GatePanel';
import { sourceLabel } from './model';
import { NowPanel } from './NowPanel';
import { PhaseStack } from './PhaseStack';
import type { WireDiagState } from '../../domain/wire';
import styles from './State.module.css';

export interface InternalStateProps {
  d: WireDiagState;
}

/** 状态: the turn in progress, the proactive speech gate and what she is doing now, the raw /diag/state folded last. */
export function InternalState({ d }: InternalStateProps) {
  const turn = fromTurnNow(d.turn);
  const live = turn != null && turn.phase != null && turn.phase !== 'ended';
  const holds = gateHolds(d.gate);
  const raw = JSON.stringify(d, null, 2);
  return (
    <section className={styles.sec} aria-label="状态" data-nav-target="diag-state">
      <SecHead
        title="当前轮"
        right={
          <span className={styles.dim}>
            回答语言错配{' '}
            <b className="num">
              {d.turn.language.mismatched}/{d.turn.language.lines}
            </b>
          </span>
        }
      />
      <div className={styles.phase}>
        <StatusLamp state={live ? 'running' : 'idle'} label={live ? sourceLabel(d.turn.source ?? '') : '空闲'} />
        {live && turn ? <PhaseStack turn={turn} /> : <span className={styles.dim}>{turn ? '上一轮已结束' : '现在没有进行中的轮次'}</span>}
        <MicroLabel>TURN LIVE</MicroLabel>
      </div>
      <div className={styles.two}>
        <GameFrame title="主动发言闸门" micro="GATE" label="主动发言闸门">
          <div className={styles.panel}>
            <div className={styles.lampHead}>
              <StatusLamp state={holds.length ? 'warning' : 'ok'} label={holds.length ? '暂时不说' : '可以说'} />
            </div>
            <GatePanel cooldowns={fromCooldowns(d.gate)} gate={d.gate} />
          </div>
        </GameFrame>
        <GameFrame title="现在" micro="CURRENT" label="现在">
          <div className={styles.panel}>
            <NowPanel d={d} />
          </div>
        </GameFrame>
      </div>
      <RawFold
        raw={raw}
        rawLabel="状态原文"
      />
    </section>
  );
}
