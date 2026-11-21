import { ChartState, type ChartStatus } from '../../charts';
import { formatClock, formatMs, type Turn } from '../../domain';
import { Btn, SecHead, Seg } from '../../ui';
import { DgTurns } from './DgTurns';
import type { FlowNode } from './flow';
import { RESULT_TEXT } from './labels';
import { sourceLabel } from './model';
import { TurnInspector } from '../chat/TurnInspector';
import type { TurnTrace } from '../chat/turnTrace';
import styles from './Dg.module.css';

export interface TurnsSectionProps {
  turns: Turn[];
  start: number;
  end: number;
  range: '24h' | '7d';
  setRange: (r: '24h' | '7d') => void;
  st: ChartStatus;
  /** agentd is gone: when the turns shown were read. */
  stoppedAt?: number | undefined;
  truncated: boolean;
  sel: Turn | null;
  onPick: (t: Turn) => void;
  /** The flow node the turns are filtered by. */
  node: FlowNode | null;
  onClearNode: () => void;
  trace: TurnTrace | null;
  traceSt: ChartStatus;
  onRecords: (() => void) | null;
  onChat: (() => void) | null;
  onRetry: () => void;
}

/** 02 轮次时间轴：range, count, the node filter chip and legend; the timeline; the picked turn's details below. */
export function TurnsSection(p: TurnsSectionProps) {
  const nFail = p.turns.filter((t) => t.result === 'failed').length;
  const span = p.range === '24h' ? '24 小时' : '7 天';
  return (
    <section className={styles.sec} aria-label="轮次时间轴">
      <SecHead
        no="02"
        title="轮次时间轴"
        right={
          p.trace ? (
            <span className={styles.t2}>
              已选中第 <span className="num">{p.trace.no}</span> 轮
            </span>
          ) : null
        }
      />
      <div className={styles.tlH}>
        <Seg size="sm" label="范围" value={p.range} options={[{ value: '24h', label: '24 h' }, { value: '7d', label: '7 天' }]} onChange={(v) => p.setRange(v === '7d' ? '7d' : '24h')} />
        {p.st === 'ok' && (
          <span className={styles.t2}>
            <span className={`num ${styles.t1}`}>{p.turns.length}</span> 轮 │ 失败 <span className="num">{nFail}</span>
            {p.truncated && ' │ 只显示最新 200 轮'}
          </span>
        )}
        {p.st === 'ok' && p.stoppedAt != null && (
          <span className={styles.t2} role="status">
            <span className="num">{formatClock(p.stoppedAt)}</span> 的数据
          </span>
        )}
        {p.node && (
          <span className={styles.fchip}>
            经过「{p.node.label}」
            <button type="button" aria-label="清除筛选" onClick={p.onClearNode}>
              ✕
            </button>
          </span>
        )}
        <span className={styles.sp} />
        <span className={styles.lg}>
          <svg className={styles.lgPo} width="5" height="5" viewBox="0 0 5 5" aria-hidden="true">
            <circle cx="2.5" cy="2.5" r="2.5" />
          </svg>
          成功
          <i className={styles.lgF} aria-hidden="true">
            ■
          </i>
          失败
          <i className={styles.lgPi} aria-hidden="true" />
          打断
          <svg className={styles.lgPs} width="3" height="3" viewBox="0 0 3 3" aria-hidden="true">
            <circle cx="1.5" cy="1.5" r="1.5" />
          </svg>
          跳过<span className={styles.t3}> │ △ 回执不全</span>
        </span>
      </div>
      <ChartState state={p.st} emptyText={p.node ? `近 ${span}没有经过「${p.node.label}」的轮次` : `近 ${span}没有轮次`} stoppedAt={p.stoppedAt} height={140}>
        {p.turns.length > 0 ? <DgTurns turns={p.turns} t0={p.start} t1={p.end} day={p.range === '7d'} sel={p.sel} onPick={p.onPick} /> : <p className={styles.empty}>{p.node ? `近 ${span}没有经过「${p.node.label}」的轮次` : `近 ${span}没有轮次`}</p>}
      </ChartState>
      {p.turns.length > 0 && (
        <details className={styles.traceList}>
          <summary>按列表查看轮次</summary>
          <ul>
            {p.turns.map((t) => {
              const cells = [formatClock(t.started_at, { seconds: true }), `${sourceLabel(t.source)}${t.head ? ` │ ${t.head}${(t.len ?? 0) > t.head.length ? '…' : ''}` : ''}`, RESULT_TEXT[t.result], formatMs(t.duration_ms)] as const;
              return <li key={t.id}>
                <button type="button" aria-pressed={p.sel?.id === t.id} aria-label={cells.join(' ')} onClick={() => p.onPick(t)}>
                  <time>{cells[0]}</time><span>{cells[1]}</span><span>{cells[2]}</span><span>{cells[3]}</span>
                </button>
              </li>;
            })}
          </ul>
        </details>
      )}
      {p.sel && (
        <div className={styles.ti} data-nav-target="diag-turn">
          <span className={styles.plateNo}>轮次详情</span>
          <TurnInspector wide tr={p.trace} st={p.traceSt} onRetry={p.onRetry} />
          {(p.onRecords || p.onChat) && (
            <div className={styles.tiF}>
              {p.onRecords && <Btn variant="text" size="sm" onClick={p.onRecords}>完整运行记录 ↗</Btn>}
              {p.onChat && <Btn variant="text" size="sm" onClick={p.onChat}>在对话中打开 ↗</Btn>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
