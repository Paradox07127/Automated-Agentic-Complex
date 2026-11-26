import type { ReactNode } from 'react';
import { stateVisual, type NodeState } from '../domain';
import { useChartLabel } from './ChartLabel';
import common from './chart.module.css';
import styles from './NodeChain.module.css';

/** One node; `waiting` overlays the "等你" mark on any node. */
export interface ChainNode {
  label: string;
  state: NodeState;
  sub?: string;
  tip?: string;
  waiting?: boolean;
}

/** Span between two nodes, weighted by real duration; `open` = still running. */
export interface ChainSegment {
  weight: number;
  label?: string;
  open?: boolean;
}

/** 节点链：已到达实心、当前画墨框、等你叠加黄块 ◆、断点黄块 ✕ 写恢复动作，下游虚线「不可达」；可按真实时长画比例段。 */
export interface NodeChainProps {
  /** 节点 */
  nodes: ChainNode[];
  /** 读屏名称，例如「交付状态」 */
  label: string;
  /** 节点之间的比例段（长度 = nodes.length − 1） */
  segments?: ChainSegment[];
  /** 节点 8 / 8 / 6 px；compact 和 desk 把段时长放第二行，默认 main */
  size?: 'main' | 'compact' | 'desk';
  /** 类别，只写进 data-category；当前节点用进行中蓝 */
  category?: 'mission' | 'neutral';
  /** 断点处的恢复动作 */
  recovery?: ReactNode;
}

/** Effective node states: everything after the first break is unreachable. */
export function chainStates(nodes: ReadonlyArray<Pick<ChainNode, 'state'>>): NodeState[] {
  const broken = nodes.findIndex((n) => n.state === 'broken');
  return nodes.map((n, i) => (broken >= 0 && i > broken ? 'unreachable' : n.state));
}

const subOf = (n: ChainNode, st: NodeState) => (st === 'unreachable' && n.state !== 'unreachable' ? '不可达' : n.sub);

/** Read-out of one node: name, state (or 等你) and its sub line. */
function nodeText(n: ChainNode, st: NodeState): string {
  const sub = subOf(n, st);
  return `${n.label}：${n.waiting || st === 'waiting' ? '待处理' : stateVisual(st).label}${sub ? `，${sub}` : ''}`;
}

export function NodeChain({ nodes, label, segments, size = 'main', category, recovery }: NodeChainProps) {
  const states = chainStates(nodes);
  const broken = states.indexOf('broken');
  // Narrow chains: a span label between two close nodes would be clipped, so durations go on a second line.
  const segBelow = size !== 'main';
  const segLabels = (segments ?? []).map((s) => s.label).filter((l): l is string => !!l);
  // Main-size span labels sit inside the aria-hidden links, so the description carries them between the nodes.
  const lbl = useChartLabel(
    label,
    nodes
      .flatMap((n, i) => {
        const span = segBelow ? undefined : segments?.[i - 1]?.label;
        return span ? [span, nodeText(n, states[i] ?? n.state)] : [nodeText(n, states[i] ?? n.state)];
      })
      .join('；'),
  );
  // Nodes with a tip are focusable: role=img would hide them from assistive tech.
  const named = nodes.some((n) => n.tip) ? { 'aria-labelledby': lbl.img['aria-labelledby'], 'aria-describedby': lbl.img['aria-describedby'] } : lbl.img;
  return (
    <div data-stub="NodeChain" data-size={size} data-category={category} className={styles.root}>
      {lbl.text}
      <ol className={styles.chain} {...named}>
        {nodes.map((n, i) => {
          const st = states[i] ?? n.state;
          const wait = n.waiting || st === 'waiting';
          const sub = subOf(n, st);
          const seg = i > 0 ? segments?.[i - 1] : undefined;
          const text = nodeText(n, st);
          return (
            <li key={i} className={styles.item} data-state={st} data-waiting={wait || undefined} style={seg ? { flexGrow: Math.max(0.2, seg.weight) } : undefined}>
              {i > 0 && (
                <span className={styles.link} data-dash={(broken >= 0 && i > broken) || undefined} data-open={seg?.open || undefined} aria-hidden="true">
                  <i />
                  {seg?.label && !segBelow && <span className={styles.segLabel}>{seg.label}</span>}
                </span>
              )}
              <span className={`${styles.node} ${common.tip}`} data-tip={n.tip} tabIndex={n.tip ? 0 : undefined} aria-label={text}>
                <span className={styles.dot} aria-hidden="true">
                  {st === 'broken' ? '✕' : st === 'ok' ? '✓' : ''}
                </span>
                <span className={styles.label} aria-hidden="true">
                  {n.label}
                </span>
                {(sub || wait) && (
                  <span className={styles.sub} aria-hidden="true">
                    {sub ?? '待处理'}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {segBelow && segLabels.length > 0 && <p className={styles.segLine}>{segLabels.join(' │ ')}</p>}
      {recovery && broken >= 0 && (
        <p className={styles.recovery}>
          <span className={styles.recoveryMark} aria-hidden="true">
            ✕
          </span>
          {recovery}
        </p>
      )}
    </div>
  );
}

const DELIVERY: ChainNode[] = [
  { label: '产出', state: 'done', sub: '14:26' },
  { label: '送达', state: 'done', sub: '14:27' },
  { label: '查看', state: 'done', sub: '14:30' },
  { label: '决定', state: 'current', waiting: true, sub: '待处理' },
];
const DELIVERY_SEGS: ChainSegment[] = [
  { weight: 1, label: '1 m' },
  { weight: 3, label: '3 m' },
  { weight: 2, label: '等待 2 m', open: true },
];

export const NodeChainDemos: Array<{ name: string; props: NodeChainProps }> = [
  { name: 'delivery', props: { label: '交付状态', nodes: DELIVERY, segments: DELIVERY_SEGS } },
  { name: 'compact', props: { label: '交付状态', size: 'compact', nodes: DELIVERY, segments: DELIVERY_SEGS } },
  { name: 'broken', props: { label: '内核就绪', nodes: [{ label: '已安装', state: 'done' }, { label: '版本可用', state: 'done' }, { label: '已登录', state: 'broken', sub: '未登录' }, { label: '可运行', state: 'todo' }], recovery: '在终端执行 codex login' } },
  { name: 'desk', props: { label: '交付状态', size: 'desk', nodes: [{ label: '产出', state: 'done' }, { label: '送达', state: 'done' }, { label: '查看', state: 'todo' }, { label: '决定', state: 'todo' }] } },
  { name: 'accepted', props: { label: '交付状态', nodes: [{ label: '产出', state: 'done', sub: '14:26' }, { label: '送达', state: 'done', sub: '14:27' }, { label: '查看', state: 'done', sub: '14:30' }, { label: '已接受', state: 'ok', sub: '14:31' }], segments: [{ weight: 1, label: '1 m' }, { weight: 3, label: '3 m' }, { weight: 1, label: '1 m' }] } },
  { name: 'running', props: { label: '运行阶段', category: 'neutral', nodes: [{ label: '准备', state: 'done' }, { label: '执行', state: 'current', sub: '06:12', tip: '执行 │ 已 6 分 12 秒' }, { label: '验证', state: 'todo' }, { label: '结束', state: 'todo' }] } },
  { name: 'hooks', props: { label: 'Hook 链路', nodes: [{ label: '已安装', state: 'done' }, { label: '有回调', state: 'todo', sub: '还没有回调' }] } },
];
