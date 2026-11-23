// Pipeline flow model: node layout, the path a turn takes, and last-hour counts from /trace/turns and /trace/decisions.
import type { Turn, TurnResult } from '../../domain';
import { isoToMs } from '../../domain/units';
import type { WireTraceEvent } from './wire';

export type NodeId = 'obs' | 'interp' | 'input' | 'ctx' | 'judge' | 'model' | 'line' | 'tts' | 'play' | 'motion' | 'hook' | 'sess' | 'appr' | 'memx';
export type NodeState = 'ok' | 'att' | 'fail' | 'idle';

export interface NodeStat {
  count: number;
  /** Median time spent in the node; null while no source reports it. */
  p50: number | null;
  fail: number;
}

export interface FlowNode {
  id: NodeId;
  label: string;
  xi: number;
  yi: number;
  stat: NodeStat | null;
  state: NodeState;
  /** Second line when there is no stat (the hook node reads the hook block). */
  sub?: string;
  /** The memory pipeline station this node opens; such a node keeps no count of its own. */
  station?: 'obs' | 'interp' | 'mem';
}

export interface FlowEdge {
  from: NodeId;
  to: NodeId;
  n?: number;
}

export const COLS = 8;
export const LANES: ReadonlyArray<[string, string]> = [
  ['观察旁路', 'SIDE'],
  ['主线', 'MAIN'],
  ['Claude / Codex', 'HOOK'],
];

/** server.py PHASES drawn as one production line; the side lanes are the memory pipeline's stations and the coding-tool hooks. */
const NODE_DEF: ReadonlyArray<[NodeId, string, number, number]> = [
  ['obs', '观察', 0, 0],
  ['interp', '解读', 1, 0],
  ['input', '输入', 0, 1],
  ['ctx', '上下文', 1, 1],
  ['judge', '判断', 2, 1],
  ['model', '模型', 3, 1],
  ['line', '台词', 4, 1],
  ['tts', '语音', 5, 1],
  ['play', '播放', 6, 1],
  ['motion', '动作', 7, 1],
  ['hook', '编码 hook', 0, 2],
  ['sess', '会话', 1, 2],
  ['appr', '审批', 2, 2],
  ['memx', '记忆提取', 4, 2],
];

/** Nodes whose numbers live on the 记忆管线 page. */
const STATION: Partial<Record<NodeId, 'obs' | 'interp' | 'mem'>> = { obs: 'obs', interp: 'interp', memx: 'mem' };

const EDGE_DEF: ReadonlyArray<[NodeId, NodeId]> = [
  ['obs', 'interp'],
  ['interp', 'ctx'],
  ['input', 'ctx'],
  ['ctx', 'judge'],
  ['judge', 'model'],
  ['model', 'line'],
  ['line', 'tts'],
  ['tts', 'play'],
  ['play', 'motion'],
  ['line', 'memx'],
  ['hook', 'sess'],
  ['sess', 'appr'],
];

export const STATE_TEXT: Record<NodeState, string> = { ok: '正常', att: '需要注意', fail: '有失败', idle: '空闲' };
export const HOOK_TIP = 'Claude Code / Codex 的 hook 事件';

const MAIN: NodeId[] = ['input', 'ctx', 'judge', 'model', 'line', 'tts', 'play', 'motion'];
/** input.received sources that start from an observation rather than the user. */
const PROACTIVE = new Set(['proactive', 'announce', 'ritual', 'tap']);

/** The nodes a turn walks: proactive turns enter from the observation lane; a skip stops at the judge, a failure where it failed. */
export function pathOf(source: string, result: TurnResult, failAt: NodeId | null = null): NodeId[] {
  let p: NodeId[] = PROACTIVE.has(source) ? ['obs', 'interp', ...MAIN.slice(1)] : [...MAIN];
  const cut = (id: NodeId) => {
    const i = p.indexOf(id);
    if (i >= 0) p = p.slice(0, i + 1);
  };
  if (result === 'skipped') cut('judge');
  else if (result === 'failed') cut(failAt ?? 'model');
  else if (result === 'interrupted') cut('play');
  else if (result === 'running' || result === 'unknown') cut('model');
  return p;
}

/** trace_format.py kinds → the node they belong to. */
const KIND_NODE: Readonly<Record<string, NodeId>> = {
  'input.received': 'input',
  'observation.requested': 'obs',
  'observation.settled': 'obs',
  'context.assembled': 'ctx',
  'gate.decided': 'judge',
  'judge.decided': 'judge',
  'egress.checked': 'model',
  'model.started': 'model',
  'model.first_token': 'model',
  'model.finished': 'model',
  'tool.started': 'model',
  'tool.settled': 'model',
  'line.parsed': 'line',
  'speech.requested': 'tts',
  'speech.first_audio': 'tts',
  'speech.finished': 'tts',
  'playback.started': 'play',
  'playback.ended': 'play',
  'playback.interrupted': 'play',
  'motion.started': 'motion',
  'motion.ended': 'motion',
  'behavior.dispatched': 'motion',
  'behavior.receipt': 'motion',
};
export const nodeOfKind = (kind: string): NodeId | null => KIND_NODE[kind] ?? null;

export interface FlowInput {
  turns: readonly Turn[];
  decisions: readonly WireTraceEvent[];
  since: number;
  /** Failed turns whose events were read: where each one failed. */
  failAt: Readonly<Record<string, NodeId>>;
  /** The voice is unreachable, so the speech node needs attention even without a failed turn. */
  voiceDown: boolean;
  /** Coding-tool hook line (installed and last event), shown when the node has no count. */
  hookSub: string;
  /** Stats from the hourly aggregate where one exists (mock `full` demo); they replace the computed ones. */
  hourly?: Partial<Record<NodeId, NodeStat>> | null;
  /** /diag/state `stages`: the last hour's median ms of the nodes agentd times. */
  p50?: Partial<Record<NodeId, number>>;
}

/** Approvals opened since `since` and not decided yet. */
export function waitingApprovals(decisions: readonly WireTraceEvent[], since: number): number {
  const recent = decisions.filter((e) => isoToMs(e.t_wall) >= since);
  const decided = new Set(recent.filter((e) => e.kind === 'approval.decided').map((e) => String(e.attrs.approval_id ?? e.trace_id)));
  return recent.filter((e) => e.kind === 'approval.opened' && !decided.has(String(e.attrs.approval_id ?? e.trace_id))).length;
}

/** Last-hour nodes and belts; counts come from the turn paths and the decisions. */
export function flowOf(f: FlowInput): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const count = new Map<NodeId, number>();
  const fail = new Map<NodeId, number>();
  const edgeN = new Map<string, number>();
  const add = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  for (const t of f.turns) {
    if (t.started_at < f.since) continue;
    const p = pathOf(t.source, t.result, f.failAt[t.id] ?? null);
    p.forEach((id, i) => {
      add(count, id);
      if (i > 0) add(edgeN, `${p[i - 1]}>${id}`);
    });
    if (t.result === 'failed') add(fail, p.at(-1) ?? 'model');
  }
  const recent = f.decisions.filter((e) => isoToMs(e.t_wall) >= f.since);
  const requests = new Set(recent.filter((e) => e.kind.startsWith('dispatch.')).map((e) => String(e.attrs.request_id ?? e.event_id)));
  const opened = recent.filter((e) => e.kind === 'approval.opened');
  if (requests.size) count.set('sess', requests.size);
  if (opened.length) {
    count.set('appr', opened.length);
    add(edgeN, 'sess>appr', opened.length);
  }
  const waiting = waitingApprovals(f.decisions, f.since) > 0;
  const nodes = NODE_DEF.map(([id, label, xi, yi]): FlowNode => {
    const station = STATION[id];
    if (station) return { id, label, xi, yi, stat: null, state: 'idle', station };
    const h = f.hourly?.[id];
    const n = h?.count ?? count.get(id) ?? 0;
    const stat: NodeStat | null = h ?? (n > 0 ? { count: n, p50: f.p50?.[id] ?? null, fail: fail.get(id) ?? 0 } : null);
    const att = (id === 'tts' && f.voiceDown) || (id === 'appr' && waiting);
    const state: NodeState = stat && stat.fail > 0 ? 'fail' : att ? 'att' : stat && stat.count > 0 ? 'ok' : 'idle';
    return { id, label, xi, yi, stat: stat && stat.count > 0 ? stat : null, state, ...(id === 'hook' ? { sub: f.hookSub } : {}) };
  });
  const edges = EDGE_DEF.map(([from, to]): FlowEdge => {
    // What flows into a station is the pipeline page's number.
    const n = STATION[to] ? 0 : f.hourly ? (f.hourly[to]?.count ?? 0) : (edgeN.get(`${from}>${to}`) ?? 0);
    return { from, to, ...(n > 0 ? { n } : {}) };
  });
  return { nodes, edges };
}

/** /diag/state turn.phase → the belt the turn in progress is on. */
const PHASE_EDGE: Readonly<Record<string, [NodeId, NodeId]>> = {
  received: ['input', 'ctx'],
  waiting_observation: ['obs', 'interp'],
  assembling: ['ctx', 'judge'],
  calling_model: ['judge', 'model'],
  streaming: ['model', 'line'],
  synthesizing: ['line', 'tts'],
  playing: ['tts', 'play'],
};
export const liveEdgeOf = (phase: string | null | undefined): [NodeId, NodeId] | null => (phase ? (PHASE_EDGE[phase] ?? null) : null);
