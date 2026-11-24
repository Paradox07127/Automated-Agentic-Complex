import { ChartBox, useChart, type ChartCommonProps } from './ChartBox';
import { calm, clampN, cx, pad2, pressable } from './v3';
import { formatMs } from '../domain';
import f from './FlowGraph.module.css';

type XY = [number, number];

export interface FlowNode {
  id: string;
  label: string;
  /** 节点中心，viewBox 坐标 */
  x: number;
  y: number;
  /** 近 1 小时：次数、p50 ms、失败 */
  stat?: { count: number; p50: number; fail: number };
  state?: 'ok' | 'att' | 'fail' | 'idle';
  tone?: 'dark' | 'paper';
}

export interface FlowEdge {
  from: string;
  to: string;
  n?: number;
  /** 流动光点（减弱动效时静止） */
  live?: boolean;
}

/** 工厂俯视图式流程图：带编号的节点，可点时是右下切角的看板；直角走线的灰色传送带；hl 路径上的边用 trace；pulses 放一个 trace 光点；需要注意和失败用黄块墨字。 */
export interface FlowGraphProps extends ChartCommonProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** edge 是下标或 'from>to'，at 是 0–1 */
  pulses?: Array<{ edge: number | string; at: number }>;
  /** 高亮路径（节点 id 顺序） */
  hl?: string[];
  onPick?: (id: string) => void;
  sel?: string | null;
  /** viewBox 宽，默认 960；整图按容器宽度缩放 */
  w?: number;
  h?: number;
  nodeW?: number;
  nodeH?: number;
  emph?: string;
}

/** Right-angle route between two node centres. */
export function flowRoute(a: { x: number; y: number }, b: { x: number; y: number }, nw: number, nh: number): XY[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const hw = nw / 2;
  const hh = nh / 2;
  if (Math.abs(dy) < hh) {
    if (dx > 0) {
      const p1: XY = [a.x + hw, a.y];
      const p2: XY = [b.x - hw, b.y];
      return a.y === b.y ? [p1, p2] : [p1, [(p1[0] + p2[0]) / 2, p1[1]], [(p1[0] + p2[0]) / 2, p2[1]], p2];
    }
    const yy = Math.max(a.y, b.y) + hh + 18;
    return [[a.x, a.y + hh], [a.x, yy], [b.x, yy], [b.x, b.y + hh]];
  }
  if (Math.abs(dx) < nw) {
    const sg = dy > 0 ? 1 : -1;
    const p1: XY = [a.x, a.y + sg * hh];
    const p2: XY = [b.x, b.y - sg * hh];
    const my = (p1[1] + p2[1]) / 2;
    return a.x === b.x ? [p1, p2] : [p1, [p1[0], my], [p2[0], my], p2];
  }
  if (dy > 0) return [[a.x, a.y + hh], [a.x, b.y], [b.x + (dx > 0 ? -hw : hw), b.y]];
  return [[a.x + (dx > 0 ? hw : -hw), a.y], [b.x, a.y], [b.x, b.y + hh]];
}

const polyLen = (ps: XY[]) => ps.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - ps[i]![0], p[1] - ps[i]![1]), 0);

/** Point and heading at fraction `t` along a polyline. */
function polyAt(ps: XY[], t: number): [number, number, number] {
  let d = polyLen(ps) * clampN(t, 0, 1);
  for (let i = 1; i < ps.length; i++) {
    const [x0, y0] = ps[i - 1]!;
    const [x1, y1] = ps[i]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (d <= len || i === ps.length - 1) {
      const k = len ? Math.min(1, d / len) : 0;
      return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, Math.atan2(y1 - y0, x1 - x0)];
    }
    d -= len;
  }
  return [ps[0]?.[0] ?? 0, ps[0]?.[1] ?? 0, 0];
}

const ST: Record<NonNullable<FlowNode['state']>, [string, string]> = { ok: ['正常', ''], att: ['需要注意', '▲'], fail: ['失败', '✕'], idle: ['空闲', ''] };
/** Bottom-right cut of a pressable node, in viewBox units. */
const CUT = 8;
const deg = (a: number) => ((a * 180) / Math.PI).toFixed(0);
const xy = (x: number, y: number) => `translate(${x.toFixed(1)} ${y.toFixed(1)})`;

export function FlowGraph({ nodes, edges, pulses = [], hl = [], onPick, sel, w = 960, h = 300, nodeW = 96, nodeH = 48, label = '流程图', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: FlowGraphProps) {
  const c = useChart();
  if (!nodes.length && st === 'ok') st = 'empty';
  const N = new Map(nodes.map((n, i) => [n.id, { ...n, no: pad2(i + 1) }]));
  const still = calm();
  const hlSet = new Set(hl);
  const onPath = (e: FlowEdge) => hl.some((id, i) => id === e.from && hl[i + 1] === e.to);
  const E = edges.flatMap((e, i) => {
    const a = N.get(e.from);
    const b = N.get(e.to);
    if (!a || !b) return [];
    const ps = flowRoute(a, b, nodeW, nodeH);
    return [{ ...e, i, ps, d: `M${ps.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}`, len: polyLen(ps) }];
  });
  const edgeOf = (k: number | string) => (typeof k === 'number' ? E[k] : E.find((e) => `${e.from}>${e.to}` === k));
  const scale = c.W / w;
  const named = (k: 'fail' | 'att') => nodes.filter((n) => n.state === k).map((n) => n.label).join('、');
  const aria = `${label}：${nodes.length} 个节点${named('fail') ? `，失败：${named('fail')}` : ''}${named('att') ? `，需要注意：${named('att')}` : ''}`;
  const tipOf = (n: FlowNode & { no: string }) => [`${n.no} ${n.label}${n.state ? ` │ ${ST[n.state][0]}` : ''}`, n.stat && `近 1 小时 ${n.stat.count} 次 │ p50 ${formatMs(n.stat.p50)}`, n.stat?.fail ? `失败 ${n.stat.fail}` : null].filter(Boolean).join('\n');
  const table = { cols: ['节点', '次数', 'p50', '失败', '状态'], rows: nodes.map((n) => [`${N.get(n.id)?.no} ${n.label}`, n.stat ? String(n.stat.count) : '—', n.stat ? formatMs(n.stat.p50) : '—', n.stat ? String(n.stat.fail) : '—', n.state ? ST[n.state][0] : '—']) };
  return (
    <ChartBox name="FlowGraph" c={c} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} h={h * scale} table={table} frame={frame}>
      <svg className={f.flow} width={c.W} height={h * scale} viewBox={`0 0 ${w} ${h}`} role={onPick ? 'group' : 'img'} aria-label={aria}>
        {E.map((e) => {
          const dim = hl.length > 0 && !onPath(e);
          const chev: Array<[number, number, number]> = [];
          for (let k = 14; k < e.len - 14; k += 18) chev.push(polyAt(e.ps, k / e.len));
          const end = polyAt(e.ps, 1);
          const mid = polyAt(e.ps, 0.5);
          const p40 = polyAt(e.ps, 0.4);
          return (
            <g key={`e${e.i}`} className={cx(f.belt, dim && f.dim, onPath(e) && f.hl)} data-edge={`${e.from}>${e.to}`}>
              <path d={e.d} className={f.edge} />
              <path d={e.d} className={f.base} />
              {chev.map(([x, y, a], k) => (
                <path key={k} d="M-2.5 -3L1.5 0L-2.5 3" transform={`${xy(x, y)} rotate(${deg(a)})`} className={f.chev} />
              ))}
              <path d="M-6 -5L2 0L-6 5Z" transform={`${xy(end[0], end[1])} rotate(${deg(end[2])})`} className={f.arrow} />
              {e.n != null && (
                <text x={mid[0]} y={mid[1] - 9} textAnchor="middle" className={f.n}>
                  {e.n}
                </text>
              )}
              {e.live && !dim && (still ? <circle cx={p40[0]} cy={p40[1]} r="3" className={f.pulse} /> : <circle r="3" className={f.pulse}><animateMotion dur={`${Math.max(1.2, e.len / 70).toFixed(2)}s`} repeatCount="indefinite" path={e.d} /></circle>)}
            </g>
          );
        })}
        {pulses.map((p, i) => {
          const e = edgeOf(p.edge);
          if (!e) return null;
          const [x, y] = polyAt(e.ps, p.at);
          return (
            <circle key={`p${i}`} cx={x} cy={y} r="4" className={f.on} />
          );
        })}
        {nodes.map((n0) => {
          const n = N.get(n0.id)!;
          const dim = hl.length > 0 && !hlSet.has(n.id);
          const flag = n.stat?.fail ? `✕${n.stat.fail}` : n.state ? ST[n.state][1] : '';
          const fw = 8 + flag.length * 7;
          return (
            <g key={n.id} className={cx(f.node, n.tone === 'paper' ? f.paper : f.dark, n.state && f[`st${n.state}`], dim && f.dimNode, hlSet.has(n.id) && f.hlNode, (sel === n.id || emph === n.id) && f.sel)} transform={`translate(${n.x - nodeW / 2} ${n.y - nodeH / 2})`} {...(onPick && pressable(tipOf(n).replace(/\n/g, ' '), () => onPick(n.id)))} onMouseMove={(e) => c.show(e, tipOf(n))} data-node={n.id} data-press={onPick ? '' : undefined}>
              <path d={onPick ? `M0 0H${nodeW}V${nodeH - CUT}L${nodeW - CUT} ${nodeH}H0Z` : `M0 0H${nodeW}V${nodeH}H0Z`} className={f.box} />
              {onPick && <rect width={nodeW} height="3" className={f.tab} />}
              <rect width="22" height="14" className={f.nb} />
              <text x="11" y="11" textAnchor="middle" className={f.no}>
                {n.no}
              </text>
              <text x="28" y="12" className={f.label}>
                {n.label}
              </text>
              {n.stat && (
                <text x="8" y={nodeH - 9} className={f.stat}>
                  {n.stat.count} │ {formatMs(n.stat.p50)}
                </text>
              )}
              {flag && (
                <g className={f.flag} data-flag="">
                  <rect x={nodeW - 4 - fw} y="3" width={fw} height="15" />
                  <text x={nodeW - 4 - fw / 2} y="14.5" textAnchor="middle">
                    {flag}
                  </text>
                </g>
              )}
              {n.state === 'ok' && <rect x={nodeW - 12} y="6" width="4" height="4" className={f.okMark} />}
            </g>
          );
        })}
      </svg>
    </ChartBox>
  );
}

const NODES: FlowNode[] = [
  { id: 'obs', label: '观察', x: 70, y: 30, stat: { count: 58, p50: 820, fail: 0 }, state: 'ok' },
  { id: 'interp', label: '解读', x: 200, y: 30, stat: { count: 41, p50: 1240, fail: 1 }, state: 'att' },
  { id: 'input', label: '输入', x: 70, y: 112, stat: { count: 12, p50: 4, fail: 0 }, state: 'ok' },
  { id: 'ctx', label: '上下文', x: 200, y: 112, stat: { count: 53, p50: 38, fail: 0 }, state: 'ok' },
  { id: 'judge', label: '判断', x: 330, y: 112, stat: { count: 53, p50: 410, fail: 0 }, state: 'ok' },
  { id: 'model', label: '模型', x: 460, y: 112, stat: { count: 18, p50: 3120, fail: 0 }, state: 'ok', tone: 'paper' },
  { id: 'line', label: '台词', x: 590, y: 112, stat: { count: 18, p50: 1120, fail: 0 }, state: 'ok' },
  { id: 'tts', label: '语音', x: 720, y: 112, stat: { count: 16, p50: 640, fail: 2 }, state: 'fail' },
  { id: 'play', label: '播放', x: 850, y: 112, stat: { count: 14, p50: 2400, fail: 0 }, state: 'ok' },
  { id: 'motion', label: '动作', x: 980, y: 112, stat: { count: 22, p50: 1200, fail: 0 }, state: 'ok' },
  { id: 'memx', label: '记忆提取', x: 330, y: 196, stat: { count: 6, p50: 5400, fail: 0 }, state: 'idle' },
  { id: 'hook', label: '编码 hook', x: 590, y: 196, stat: { count: 31, p50: 12, fail: 0 }, state: 'ok' },
  { id: 'sess', label: '会话', x: 720, y: 196, stat: { count: 9, p50: 180, fail: 0 }, state: 'ok' },
  { id: 'appr', label: '审批', x: 850, y: 196, stat: { count: 5, p50: 22000, fail: 0 }, state: 'att' },
];
const EDGES: FlowEdge[] = [
  { from: 'obs', to: 'interp', n: 41 },
  { from: 'interp', to: 'ctx' },
  { from: 'input', to: 'ctx', n: 12, live: true },
  { from: 'ctx', to: 'judge', live: true },
  { from: 'judge', to: 'model', n: 18, live: true },
  { from: 'model', to: 'line' },
  { from: 'line', to: 'tts' },
  { from: 'tts', to: 'play', n: 14 },
  { from: 'play', to: 'motion' },
  { from: 'model', to: 'memx', n: 6 },
  { from: 'hook', to: 'sess', live: true },
  { from: 'sess', to: 'appr', n: 5 },
];
const base = { label: '一轮的流程图', nodes: NODES, edges: EDGES, w: 1060, h: 236, nodeW: 100, nodeH: 46 };

export const FlowGraphDemos: Array<{ name: string; props: FlowGraphProps }> = [
  { name: 'live', props: { ...base, sel: 'judge', onPick: () => undefined } },
  { name: 'replay', props: { ...base, hl: ['input', 'ctx', 'judge', 'model', 'line', 'tts', 'play', 'motion'], pulses: [{ edge: 'tts>play', at: 0.55 }] } },
  { name: 'empty', props: { ...base, empty: '还没有流程数据', nodes: [], edges: [] } },
];
