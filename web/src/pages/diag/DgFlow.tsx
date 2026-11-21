import { useWidth } from '../../charts/useWidth';
import { formatMs } from '../../domain';
import { COLS, HOOK_TIP, LANES, STATE_TEXT, type FlowEdge, type FlowNode, type NodeId, type NodeStat } from './flow';
import styles from './Flow.module.css';

const LH = 92;
const NH = 56;
const NT = 30;

export interface DgFlowProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Replay path of the selected turn; empty when none is selected. */
  path: NodeId[];
  /** Nodes lit so far in the replay. */
  lit: NodeId[];
  /** Belt the replay is crossing now. */
  pulse: [NodeId, NodeId] | null;
  /** Node the turn list is filtered by. */
  sel: NodeId | null;
  onPick: (id: NodeId) => void;
  /** Belt of the turn in progress; null while none runs or the page is paused. */
  live: [NodeId, NodeId] | null;
  /** agentd is gone: no moving dot; the data stays readable under the section's time tag. */
  dead: boolean;
  /** No moving dot (reduced motion or a still screenshot). */
  calm: boolean;
}

const statText = (s: NodeStat, tight: boolean) => {
  if (s.p50 == null) return `${s.count} 次`;
  return tight ? `${s.count}·${formatMs(s.p50).replace(' ', '')}` : `${s.count} │ ${formatMs(s.p50)}`;
};

export function nodeTip(n: FlowNode): string {
  const head = `${n.label} │ ${STATE_TEXT[n.state]}`;
  const s = n.stat;
  const body = s ? `近 1 小时 ${s.count} 次${s.p50 != null ? ` │ p50 ${formatMs(s.p50)}` : ''}${s.fail ? ` │ 失败 ${s.fail}` : ''}` : n.sub ? n.sub : '近 1 小时未经过';
  return [head, body, n.id === 'hook' ? HOOK_TIP : null].filter(Boolean).join('\n');
}

/** Pipeline chart: plates on three lanes, belts as thin lines with direction ticks; only the replayed turn and failures take colour. Columns spread with the width, text keeps its size. */
export function DgFlow({ nodes, edges, path, lit, pulse, sel, onPick, live, dead, calm }: DgFlowProps) {
  const [ref, W] = useWidth<HTMLDivElement>(960);
  const colW = W / COLS;
  const nw = Math.max(68, Math.min(150, Math.round(colW * 0.74)));
  const tight = nw < 90;
  const N = new Map(nodes.map((n) => [n.id, { ...n, cx: colW * (n.xi + 0.5), top: n.yi * LH + NT }]));
  const H = LANES.length * LH;
  const replay = path.length > 0;
  const onPath = new Set(path);
  const litSet = new Set(lit);
  const pairIn = (list: NodeId[], e: FlowEdge) => list.some((id, i) => id === e.from && list[i + 1] === e.to);
  const E = edges.flatMap((e) => {
    const a = N.get(e.from);
    const b = N.get(e.to);
    if (!a || !b) return [];
    if (a.yi === b.yi) {
      const y = a.top + NH / 2;
      return [{ ...e, x1: a.cx + nw / 2 + 3, y1: y, x2: b.cx - nw / 2 - 3, y2: y, h: true }];
    }
    return [{ ...e, x1: a.cx, y1: a.top + NH + 3, x2: a.cx, y2: b.top - 3, h: false }];
  });
  return (
    <div ref={ref} className={styles.flowc} data-dead={dead || undefined} data-tight={tight || undefined} style={{ height: H }}>
      {LANES.map(([l], yi) => (
        <div key={l} className={styles.lane} style={{ top: yi * LH, height: LH }}>
          <span>{l}</span>
        </div>
      ))}
      <svg className={styles.belts} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {E.map((e) => {
          const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
          const rot = e.h ? 0 : 90;
          const at = (f: number): [number, number] => [e.x1 + (e.x2 - e.x1) * f, e.y1 + (e.y2 - e.y1) * f];
          const ticks: Array<[number, number]> = [];
          for (let s = 7; s < len - 9; s += 8) ticks.push(at(s / len));
          const mid = at(0.5);
          const d = `M${e.x1} ${e.y1}L${e.x2} ${e.y2}`;
          const isLive = !replay && live != null && live[0] === e.from && live[1] === e.to;
          return (
            <g key={`${e.from}>${e.to}`} className={styles.belt} data-on={pairIn(lit, e) || undefined} data-dim={(replay && !pairIn(path, e)) || undefined}>
              <path d={d} className={styles.ln} />
              {ticks.map(([x, y], k) => (
                <path key={k} d="M-1.5 -2.5L1 0L-1.5 2.5" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot})`} className={styles.tk} />
              ))}
              <path d="M-4.5 -3L0 0L-4.5 3Z" transform={`translate(${e.x2.toFixed(1)} ${e.y2.toFixed(1)}) rotate(${rot})`} className={styles.hd} />
              {e.n != null && (
                <text x={e.h ? mid[0] : mid[0] + 6} y={e.h ? mid[1] - 6 : mid[1] + 3} textAnchor={e.h ? 'middle' : 'start'} className={styles.n}>
                  {e.n}
                </text>
              )}
              {isLive &&
                (calm ? (
                  <circle cx={at(0.45)[0]} cy={at(0.45)[1]} r="2.5" className={styles.dot} />
                ) : (
                  <circle r="2.5" className={styles.dot}>
                    <animateMotion dur={`${Math.max(1.2, len / 40).toFixed(2)}s`} repeatCount="indefinite" path={d} />
                  </circle>
                ))}
            </g>
          );
        })}
        {pulse &&
          (() => {
            const e = E.find((x) => x.from === pulse[0] && x.to === pulse[1]);
            if (!e) return null;
            const x = e.x1 + (e.x2 - e.x1) * 0.55;
            const y = e.y1 + (e.y2 - e.y1) * 0.55;
            return (
              <g>
                <circle cx={x} cy={y} r="6" className={styles.halo} />
                <circle cx={x} cy={y} r="3" className={styles.dot} />
              </g>
            );
          })()}
      </svg>
      {nodes.map((n0) => {
        const n = N.get(n0.id);
        if (!n) return null;
        const tip = nodeTip(n);
        return (
          <button
            key={n.id}
            type="button"
            className={styles.node}
            data-st={n.state}
            data-lit={litSet.has(n.id) || undefined}
            data-dim={(replay && !onPath.has(n.id)) || undefined}
            data-on={sel === n.id || undefined}
            style={{ left: n.cx - nw / 2, top: n.top, width: nw, height: NH }}
            aria-pressed={sel === n.id}
            aria-label={tip.replace(/\n/g, '，')}
            title={tip}
            onClick={() => onPick(n.id)}
          >
            {n.state === 'fail' ? (
              <span className={styles.nst} data-k="f" aria-hidden="true">
                ■{n.stat && n.stat.fail ? <b>{n.stat.fail}</b> : null}
              </span>
            ) : n.state === 'att' ? (
              <span className={styles.nst} data-k="a" aria-hidden="true">
                ▲
              </span>
            ) : null}
            <b className={styles.nl}>{n.label}</b>
            <span className={`${styles.ns} num`}>{n.stat ? statText(n.stat, tight) : (n.sub ?? '0 次')}</span>
          </button>
        );
      })}
    </div>
  );
}
