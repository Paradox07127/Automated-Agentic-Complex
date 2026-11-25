import type { ReactNode } from 'react';
import { formatClock, formatMs, type VisualStateKey } from '../../domain';
import { Btn, SecHead, Sheet, Skel } from '../../ui';
import { GameTable, ReadTick, StatusLamp } from '../../ui/game';
import { DgFlow } from './DgFlow';
import { STATE_TEXT, type FlowEdge, type FlowNode, type NodeId, type NodeState } from './flow';
import styles from './Flow.module.css';

const LAMP: Record<NodeState, VisualStateKey> = { ok: 'ok', fail: 'failed', att: 'warning', idle: 'idle' };

/** One failed turn of the last hour, placed on its node. */
export interface FailRow {
  /** trace_id */
  id: string;
  turn_id: string;
  at: number;
  /** 你说 / 她主动 */
  src: string;
  /** The failed event's code, or its kind. */
  code: string;
}

export interface FlowSectionProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  loading: boolean;
  /** Why /trace/turns could not be read. */
  error: string | null;
  onRetry: () => void;
  turns: number;
  fails: number;
  /** Label of the node the turn in progress is on; null while none runs. */
  liveAt: string | null;
  live: [NodeId, NodeId] | null;
  /** agentd is gone. */
  dead: boolean;
  calm: boolean;
  sel: NodeId | null;
  onPick: (id: NodeId) => void;
  onClear: () => void;
  onStation: (station: 'obs' | 'interp' | 'mem') => void;
  failsOf: (id: NodeId) => FailRow[];
  approvals: number;
  onTasks: () => void;
  /** 对话轮次: that turn, or the list. */
  onTrace: (turnId: string | null) => void;
  onChat: () => void;
  /** 设置 › 交流, for a voice node waiting on an unreachable TTS. */
  onVoice: () => void;
  /** 近 24 小时 and 模型调用 below the flow. */
  children?: ReactNode;
}

/** 管道: the last hour of the turn pipeline; a node opens its failures in the right column. */
export function FlowSection(p: FlowSectionProps) {
  const node = p.sel ? (p.nodes.find((n) => n.id === p.sel) ?? null) : null;
  return (
    <section className={styles.sec} aria-label="管道">
      <SecHead
        title="轮次管道"
        info="节点的次数是近 1 小时轮次走过的估算；耗时是后台服务记下的近 1 小时中位数，输入和台词不单独计时，写「—」，重启后台服务后重新累计。观察、解读、记忆提取的次数在记忆管线页。"
        right={
          <>
            <span className={styles.head}>
              近 1 小时 │ <b className="num">{p.turns}</b> 轮 │ 失败{' '}
              <b className="num" data-bad={p.fails > 0 || undefined}>
                {p.fails}
              </b>
              {p.liveAt && <StatusLamp state="running" label={`正在「${p.liveAt}」`} />}
            </span>
          </>
        }
      />
      {p.error && (
        <p className={styles.note} role="status">
          读不到轮次：{p.error}{' '}
          <Btn size="sm" icon="refresh" onClick={p.onRetry}>
            重试
          </Btn>
        </p>
      )}
      {!p.loading && !p.error && p.turns === 0 && (
        <p className={styles.note}>
          近 1 小时没有跑过一轮{' '}
          <Btn size="sm" onClick={p.onChat}>
            去对话
          </Btn>
        </p>
      )}
      <div className={styles.wrap}>
        <div className={styles.face}>
          {p.loading ? <Skel rows={3} shape="cards" /> : <DgFlow nodes={p.nodes} edges={p.edges} sel={p.sel} onPick={p.onPick} onStation={p.onStation} live={p.live} dead={p.dead} calm={p.calm} />}
        </div>
        <Sheet open={node != null} title={node ? `${node.label}节点` : '读法'} head="none" dockFrom={1200} onClose={p.onClear}>
          {node ? <NodeDetail node={node} fails={p.failsOf(node.id)} approvals={p.approvals} onTasks={p.onTasks} onTrace={p.onTrace} onClear={p.onClear} onVoice={p.onVoice} /> : <Legend />}
        </Sheet>
      </div>
      {p.children && <div className={styles.two}>{p.children}</div>}
    </section>
  );
}

function NodeDetail({ node, fails, approvals, onTasks, onTrace, onClear, onVoice }: { node: FlowNode; fails: FailRow[]; approvals: number; onTasks: () => void; onTrace: (turnId: string | null) => void; onClear: () => void; onVoice: () => void }) {
  const s = node.stat;
  return (
    <div className={styles.side}>
      <div className={styles.sideHead}>
        <b>{node.label}</b>
        <StatusLamp state={LAMP[node.state]} label={STATE_TEXT[node.state]} />
      </div>
      <div className={styles.band}>
        <ReadTick value={String(s?.count ?? 0)} label="近 1 小时" />
        <ReadTick value={String(s?.fail ?? 0)} label="失败" tone={s?.fail ? 'bad' : 'ink'} />
        <ReadTick value={s?.p50 == null ? '—' : formatMs(s.p50).split(' ')[0]} unit={s?.p50 == null ? undefined : formatMs(s.p50).split(' ')[1]} label="p50 耗时" tone="ink" />
      </div>
      {node.id === 'appr' && approvals > 0 && (
        <div className={styles.gr}>
          <span>审批有 {approvals} 个待处理</span>
          <Btn size="sm" onClick={onTasks}>
            去任务
          </Btn>
        </div>
      )}
      {fails.length > 0 ? (
        <GameTable
          label="最近失败"
          columns={[
            { key: 't', label: '时间', width: '68px' },
            { key: 'c', label: '失败', width: 'minmax(0, 1fr)' },
          ]}
          rows={fails.map((f) => ({
            id: f.id,
            tone: 'fail' as const,
            cells: {
              t: <span className="num">{formatClock(f.at, { seconds: true })}</span>,
              c: (
                <span>
                  {f.src} │ <span className={styles.code}>{f.code}</span>
                </span>
              ),
            },
            end: (
              <Btn size="sm" onClick={() => onTrace(f.turn_id)}>
                打开
              </Btn>
            ),
          }))}
        />
      ) : (
        <p className={styles.note}>近 1 小时没有失败</p>
      )}
      <div className={styles.acts}>
        {node.id === 'tts' && node.state === 'att' && (
          <Btn size="sm" go onClick={onVoice}>
            前往设置
          </Btn>
        )}
        <Btn size="sm" onClick={() => onTrace(null)}>
          在对话轮次里看
        </Btn>
        <Btn size="sm" variant="secondary" onClick={onClear}>
          取消选中
        </Btn>
      </div>
    </div>
  );
}

function Legend() {
  const rows: Array<[NodeState, string]> = [
    ['ok', '近 1 小时走过、没失败'],
    ['fail', '红角标是失败次数'],
    ['att', '语音连不上，或审批在等'],
    ['idle', '近 1 小时没有经过'],
  ];
  return (
    <div className={styles.side}>
      <div className={styles.sideHead}>
        <b>读法</b>
      </div>
      {rows.map(([st, text]) => (
        <div key={st} className={styles.gr}>
          <StatusLamp state={LAMP[st]} label={STATE_TEXT[st]} />
          <span>{text}</span>
        </div>
      ))}
      <p className={styles.note}>点一个节点看它的失败；单独一轮的经过在对话轮次里看。</p>
    </div>
  );
}
