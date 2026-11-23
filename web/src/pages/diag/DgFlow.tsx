import { useWidth } from '../../charts/useWidth';
import { formatMs } from '../../domain';
import { COLS, HOOK_TIP, LANES, STATE_TEXT, type FlowEdge, type FlowNode, type NodeId, type NodeStat } from './flow';
import styles from './DgFlow.module.css';

const LH = 88;
const NH = 58;
const NT = 24;

export interface DgFlowProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** The node whose detail is open. */
  sel: NodeId | null;
  onPick: (id: NodeId) => void;
  /** A 记忆管线 station node was clicked. */
  onStation: (station: 'obs' | 'interp' | 'mem') => void;
  /** Belt of the turn in progress; null while none runs or the page is paused. */
  live: [NodeId, NodeId] | null;
  /** agentd is gone: no moving dot. */
  dead: boolean;
  /** No moving dot (reduced motion or a still screenshot). */
  calm: boolean;
}

const statText = (s: NodeStat) => `${s.count} 次 │ ${s.p50 == null ? '—' : formatMs(s.p50)}`;

export function nodeTip(n: FlowNode): string {
  if (n.station) return `${n.label} │ 次数在记忆管线页`;
  const head = `${n.label} │ ${STATE_TEXT[n.state]}`;
  const s = n.stat;
  const body = s ? `近 1 小时 ${s.count} 次${s.p50 != null ? ` │ p50 ${formatMs(s.p50)}` : ''}${s.fail ? ` │ 失败 ${s.fail}` : ''}` : n.sub ? n.sub : '近 1 小时没有经过';
  return [head, body, n.id === 'hook' ? HOOK_TIP : null].filter(Boolean).join('\n');
}

/** 轮次管道: dark plates with a state strip on three lanes, dashed belts with their counts; the belt the turn in progress is on runs yellow. */
export function DgFlow({ nodes, edges, sel, onPick, onStation, live, dead, calm }: DgFlowProps) {
  const [ref, W] = useWidth<HTMLDivElement>(960);
  const colW = W / COLS;
  const nw = Math.max(84, Math.min(150, Math.round(colW - 22)));
  const N = new Map(nodes.map((n) => [n.id, { ...n, cx: colW * (n.xi + 0.5), top: n.yi * LH + NT }]));
  const H = LANES.length * LH;
  const E = edges.flatMap((e) => {
    const a = N.get(e.from);
    const b = N.get(e.to);
    if (!a || !b) return [];
    if (a.yi === b.yi) {
      const y = a.top + NH / 2;
      return [{ ...e, x1: a.cx + nw / 2, y1: y, x2: b.cx - nw / 2, y2: y, h: true }];
    }
    // A belt between lanes leaves from the lower edge of the upper node (or the upper edge of the lower one).
    const down = b.yi > a.yi;
    return [{ ...e, x1: a.cx, y1: down ? a.top + NH : a.top, x2: a.cx, y2: down ? b.top : b.top + NH, h: false }];
  });
  return (
    <div ref={ref} className={styles.flowc} data-dead={dead || undefined} style={{ height: H }}>
      {LANES.map(([l, en], yi) => (
        <div key={l} className={styles.lane} style={{ top: yi * LH, height: LH }}>
          <span>
            {l}
            <small>{en}</small>
          </span>
        </div>
      ))}
      <svg className={styles.belts} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {E.map((e) => {
          const d = `M${e.x1} ${e.y1}L${e.x2} ${e.y2}`;
          const isLive = !dead && live != null && live[0] === e.from && live[1] === e.to;
          const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
          return (
            <g key={`${e.from}>${e.to}`} className={styles.belt} data-live={isLive || undefined}>
              <path d={d} className={styles.ln} />
              {isLive &&
                (calm ? (
                  <circle cx={(e.x1 + e.x2) / 2} cy={(e.y1 + e.y2) / 2} r="3" className={styles.dot} />
                ) : (
                  <circle r="3" className={styles.dot}>
                    <animateMotion dur={`${Math.max(0.8, len / 40).toFixed(2)}s`} repeatCount="indefinite" path={d} />
                  </circle>
                ))}
            </g>
          );
        })}
      </svg>
      {E.filter((e) => e.n != null).map((e) => (
        <span
          key={`${e.from}>${e.to}n`}
          className={`${styles.n} num`}
          data-v={!e.h || undefined}
          style={e.h ? { left: (e.x1 + e.x2) / 2, top: e.y1 - 14 } : { left: e.x1 + 4, top: (e.y1 + e.y2) / 2 - 8 }}
          aria-hidden="true"
        >
          {e.n}
        </span>
      ))}
      {nodes.map((n0) => {
        const n = N.get(n0.id);
        if (!n) return null;
        const tip = nodeTip(n);
        const station = n.station;
        return (
          <button
            key={n.id}
            type="button"
            className={styles.node}
            data-st={n.state}
            data-station={station ? '' : undefined}
            data-on={sel === n.id || undefined}
            data-nav-target={`flow-${n.id}`}
            style={{ left: n.cx - nw / 2, top: n.top, width: nw, height: NH }}
            aria-pressed={station ? undefined : sel === n.id}
            aria-label={tip.replace(/\n/g, '，')}
            title={tip}
            onClick={() => (station ? onStation(station) : onPick(n.id))}
          >
            <i className={styles.strip} aria-hidden="true" />
            <b className={styles.nl}>{n.label}</b>
            <span className={`${styles.ns} num`}>{station ? '记忆管线 ›' : n.stat ? statText(n.stat) : (n.sub ?? '0 次')}</span>
            {n.state === 'fail' ? (
              <span className={styles.badge} aria-hidden="true">
                ■ <b>{n.stat?.fail ?? ''}</b>
              </span>
            ) : n.state === 'att' ? (
              <span className={styles.att} aria-hidden="true">
                ▲
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
