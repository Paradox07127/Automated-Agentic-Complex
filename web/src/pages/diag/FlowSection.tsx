import { useEffect, useState } from 'react';
import { ChartState } from '../../charts';
import { formatClock, formatMs, type Turn } from '../../domain';
import { Btn, SecHead } from '../../ui';
import { DgFlow } from './DgFlow';
import { HOOK_TIP, LANES, type FlowEdge, type FlowNode, type NodeId } from './flow';
import { RESULT_TEXT } from './labels';
import { sourceLabel } from './model';
import styles from './Dg.module.css';

/** Replay steps through the path in about 1.5 s; a still page shows it lit at once. */
export function useReplay(path: NodeId[], key: string | null, still: boolean) {
  const [step, setStep] = useState(0);
  const len = path.length;
  useEffect(() => setStep(still ? len : 1), [key, len, still]);
  useEffect(() => {
    if (still || !key || step >= len) return;
    const id = setTimeout(() => setStep((s) => s + 1), Math.round(1500 / Math.max(1, len)));
    return () => clearTimeout(id);
  }, [step, len, key, still]);
  return [key ? Math.min(step, len) : 0, () => setStep(still ? len : 1)] as const;
}

export interface FlowSectionProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  loading: boolean;
  sel: Turn | null;
  path: NodeId[];
  replayLoading: boolean;
  step: number;
  onReplay: () => void;
  onExit: () => void;
  nodeF: NodeId | null;
  onNode: (id: NodeId) => void;
  live: [NodeId, NodeId] | null;
  /** agentd is gone: the time of the data shown; null while live. */
  staleAt: number | null;
  calm: boolean;
}

/** 01 流程图：the pipeline as the page's main visual; the footer reads the replay, the picked node or a hint, then the legend. */
export function FlowSection(p: FlowSectionProps) {
  const lit = p.sel ? p.path.slice(0, p.step) : [];
  const pulse: [NodeId, NodeId] | null =
    p.sel && p.step > 0 && p.step < p.path.length && p.edges.some((e) => e.from === p.path[p.step - 1] && e.to === p.path[p.step]) ? [p.path[p.step - 1] as NodeId, p.path[p.step] as NodeId] : null;
  const selNode = p.nodeF ? p.nodes.find((n) => n.id === p.nodeF) : null;
  const s = selNode?.stat;
  return (
    <section className={styles.sec} aria-label="流程图">
      <SecHead no="01" title="流程图" right={<span className={styles.t2}>近 1 小时 │ 阶段估算</span>} />
      <div className={`${styles.flow} panel-bg`}>
        {p.loading ? (
          <ChartState state="loading" emptyText="" height={LANES.length * 92}>
            {null}
          </ChartState>
        ) : (
          <DgFlow nodes={p.nodes} edges={p.edges} path={p.sel ? p.path : []} lit={lit} pulse={pulse} sel={p.nodeF} onPick={p.onNode} live={p.live} dead={p.staleAt != null} calm={p.calm} />
        )}
        {p.staleAt != null && p.staleAt > 0 && (
          <span className={styles.stamp} role="status">
            <span className="num">{formatClock(p.staleAt)}</span> 的数据
          </span>
        )}
      </div>
      <div className={styles.flowF}>
        {p.sel ? (
          <>
            <span className={styles.replay}>
              <b>{p.path.length ? (p.step < p.path.length ? '回放中' : '已回放') : p.replayLoading ? '正在读取事件' : '没有可回放的事件'}</b> <span className="num">{formatClock(p.sel.started_at, { seconds: true })}</span> │ {sourceLabel(p.sel.source)} │ {RESULT_TEXT[p.sel.result]} │{' '}
              <span className="num">{formatMs(p.sel.duration_ms)}</span>
            </span>
            {p.path.length > 0 && <Btn variant="text" size="sm" onClick={p.onReplay}>
              重新回放
            </Btn>}
            <Btn variant="text" size="sm" onClick={p.onExit}>
              退出回放
            </Btn>
          </>
        ) : selNode ? (
          <span className={styles.t2}>
            <b className={styles.t1}>{selNode.label}</b>
            {s ? (
              <>
                {' '}
                │ 近 1 小时 <span className="num">{s.count}</span> 次{s.p50 != null && <> │ p50 <span className="num">{formatMs(s.p50)}</span></>} │ 失败 <span className="num">{s.fail}</span>
              </>
            ) : (
              ' │ 近 1 小时无统计'
            )}
            {selNode.id === 'hook' ? ` │ ${HOOK_TIP}` : ''} │ 下方时间轴已按此节点筛选
          </span>
        ) : (
          <span className={styles.t3}>细线显示估算次数。选择轮次可回放实际事件。</span>
        )}
        <span className={styles.sp} />
        <span className={styles.lg}>
          <i className={styles.lgCur} aria-hidden="true" />
          当前一轮
          <i className={styles.lgF} aria-hidden="true">
            ■
          </i>
          失败
          <i className={styles.lgA} aria-hidden="true">
            ▲
          </i>
          需要注意
          <i className={styles.lgIdle} aria-hidden="true" />
          空闲
        </span>
      </div>
    </section>
  );
}
