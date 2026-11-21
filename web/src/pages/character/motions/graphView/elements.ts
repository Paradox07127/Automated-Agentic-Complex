// 动作图: the nodes and edges of its three layers (总览, 分组, 链), the clips that could join a chain, and each joint's problems.
import type { ChainEdit } from '../../../../bridge';
import { poseGap, proposedClips, proposedSegs, withJoints } from '../chainEdit';
import { baseLabel, chainPath, gapBand, holdText, lengthText, type GapBand, type GraphIndex } from '../chainPath';
import { shortName, type ChainGroup, type GraphSeg, type MotionGraph } from '../graph';

export type GraphAt = { type: 'overview' } | { type: 'group'; id: string } | { type: 'focus'; key: string };

/** seg: a segment of the focused chain, or of a chain in the group layer; side: a clip before or after the focused chain. */
export type NodeKind = 'base' | 'group' | 'seg' | 'side' | 'more' | 'ghost';

export interface GNode {
  id: string;
  kind: NodeKind;
  /** The clip it stands for; '' on group and more nodes. */
  clip: string;
  title: string;
  sub: string;
  /** The chain a segment belongs to. */
  chain?: string;
  /** A segment's index in the chain's clips, as replace and insert edits count. */
  index?: number;
  group?: string;
  /** The clips a more node stands for. */
  names?: string[];
  /** Put in by the proposal. */
  changed?: boolean;
  pos?: { x: number; y: number };
}

/** spine: between segments; self: a loop; agg: stance to group; bb: stance to stance; thin: interrupt or skip; ls / lt: label at the source / target end. */
export type EdgeClass = 'spine' | 'self' | 'agg' | 'bb' | 'bridge' | 'thin' | 'ghost' | 'ls' | 'lt' | 'flag';

export interface GEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  band: GapBand;
  cls: EdgeClass[];
  width?: number;
}

export interface Junction {
  from: string;
  to: string;
  gap: number | null;
  blend: number | null;
  flags: string[];
  where: 'entry' | 'inner' | 'exit';
}

export interface Layer {
  nodes: GNode[];
  edges: GEdge[];
  /** Nodes carry their own positions; else dagre lays them out. */
  preset: boolean;
  junctions?: Junction[];
}

export const MATCH_CM = 8;
export const HARD_CM = 40;
export const CAP = 12;

const num = (x: number, d: number) => String(Math.round(x * 10 ** d) / 10 ** d);
export const cmText = (gap: number | null) => `${gap == null ? '—' : num(gap, 1)} cm`;
export const sText = (s: number | null) => `${s == null ? '—' : num(s, 2)} s`;
const edgeLabel = (gap: number | null, blend: number | null, extra = '') => [extra, `${cmText(gap)} │ ${sText(blend)}`].filter(Boolean).join('\n');

const SIT = new Set(['sit', 'floor', 'lie']);
const posture = (s: string | undefined) => (s == null ? null : SIT.has(s) ? '坐' : '站');

/** Where a clip comes to rest: the base itself, or the base a bridge ends on. */
const restOf = (ix: GraphIndex, clip: string) => (ix.bases.has(clip) ? clip : ix.bridges.get(clip));

const baseNode = (ix: GraphIndex, id: string, clip: string, pos?: GNode['pos']): GNode => ({
  id,
  kind: 'base',
  clip,
  title: baseLabel(ix.bases.get(clip)!),
  sub: shortName(clip),
  ...(pos ? { pos } : {}),
});

const clipSub = (ix: GraphIndex, clip: string) => {
  const c = ix.clips.get(clip);
  return [c?.loop ? '循环' : '单次', c?.length_s == null ? null : sText(c.length_s)].filter(Boolean).join(' │ ');
};

/** 总览: base stances in a column on the left, hub in the middle, chain groups in a column on the right. */
export function overview(g: MotionGraph, ix: GraphIndex, groups: ChainGroup[]): Layer {
  const ROW = 74;
  const others = [...ix.bases.values()].filter((b) => !b.hub);
  const hub = [...ix.bases.values()].filter((b) => b.hub);
  const bases = [...others.slice(0, Math.ceil(others.length / 2)), ...hub, ...others.slice(Math.ceil(others.length / 2))];
  const mid = ((groups.length - 1) * ROW) / 2;
  const nodes: GNode[] = [
    ...bases.map((b, i) => baseNode(ix, `b:${b.clip}`, b.clip, { x: 0, y: mid + (i - (bases.length - 1) / 2) * ROW * 1.4 })),
    ...groups.map((x, i): GNode => ({ id: `g:${x.id}`, kind: 'group', clip: '', group: x.id, title: x.title, sub: `${x.rows.length} 条`, pos: { x: 560, y: i * ROW } })),
  ];
  const inGroups = new Set(groups.map((x) => x.id));
  const edges: GEdge[] = [];
  const agg = new Map<string, { from: string; group: string; n: number; max: number | null }>();
  for (const e of g.edges) {
    if (!ix.bases.has(e.from)) continue;
    const to = restOf(ix, e.to);
    if (to) {
      const bridged = !ix.bases.has(e.to);
      if (to !== e.from)
        edges.push({ id: `x:${e.from}>${e.to}`, source: `b:${e.from}`, target: `b:${to}`, label: edgeLabel(e.gap, e.blend_s, bridged ? '经桥接' : ''), band: gapBand(e.gap), cls: bridged ? ['bb', 'bridge'] : ['bb'] });
      continue;
    }
    const group = ix.clips.get(e.to)?.group;
    if (!group || !inGroups.has(group)) continue;
    const k = `${e.from}|${group}`;
    const a = agg.get(k) ?? { from: e.from, group, n: 0, max: null };
    a.n += 1;
    if (e.gap != null) a.max = Math.max(a.max ?? 0, e.gap);
    agg.set(k, a);
  }
  for (const a of agg.values())
    edges.push({
      id: `a:${a.from}|${a.group}`,
      source: `b:${a.from}`,
      target: `g:${a.group}`,
      label: `${a.n} 条${a.max == null ? '' : ` │ 最大 ${cmText(a.max)}`}`,
      band: gapBand(a.max),
      cls: ['agg', 'lt'],
      width: Math.min(7, 1.5 + a.n * 0.5),
    });
  return { nodes, edges, preset: true };
}

const segNode = (id: string, key: string, seg: GraphSeg, index: number, role: string, changed: boolean): GNode => ({
  id,
  kind: 'seg',
  clip: seg.clip,
  chain: key,
  index,
  title: shortName(seg.clip),
  sub: `${role} │ ${lengthText(seg)}`,
  ...(changed ? { changed } : {}),
});

const selfLoop = (id: string, seg: GraphSeg): GEdge => ({ id: `self:${id}`, source: id, target: id, label: holdText(seg) ?? '循环', band: 0, cls: ['self'] });

/** The chain's segments and clips once `edits` are laid over it. */
function proposed(g: MotionGraph, ix: GraphIndex, key: string, edits: ChainEdit[]) {
  const segs = proposedSegs(g, ix, key, edits);
  const clips = segs.map((s) => s.clip);
  return { segs, clips, path: chainPath(withJoints(g, ix, clips), key, segs) };
}

/** 分组: each chain of the group from the stance it is entered from, through its segments, to the stances it comes back to. */
export function groupLayer(g: MotionGraph, ix: GraphIndex, group: string, edits: ChainEdit[]): Layer {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const have = new Set<string>();
  const base = (side: 'L' | 'R', clip: string) => {
    const id = `${side}:${clip}`;
    if (!have.has(id)) nodes.push(baseNode(ix, id, clip));
    have.add(id);
    return id;
  };
  const keys = Object.keys(g.chains).filter((k) => ix.clips.get(k)?.group === group);
  for (const key of keys) {
    const shipped = new Set(g.chains[key]!.map((s) => s.clip));
    const { path } = proposed(g, ix, key, edits);
    const ids = path.segs.map((s, i) => {
      const id = `k:${key}|${i}`;
      nodes.push(segNode(id, key, s.seg, i, s.role, !shipped.has(s.seg.clip)));
      if (s.seg.loop) edges.push(selfLoop(id, s.seg));
      if (i > 0) edges.push({ id: `e:${key}|${i}`, source: `k:${key}|${i - 1}`, target: id, label: edgeLabel(s.joint!.gap, s.joint!.blend), band: gapBand(s.joint!.gap), cls: ['spine'] });
      return id;
    });
    for (const x of path.entry)
      edges.push({ id: `in:${key}|${x.base.clip}`, source: base('L', x.base.clip), target: ids[0]!, label: edgeLabel(x.joint.gap, x.joint.blend), band: gapBand(x.joint.gap), cls: ['lt'] });
    for (const x of path.back)
      edges.push({
        id: `out:${key}|${x.via ?? x.base.clip}`,
        source: ids[ids.length - 1]!,
        target: base('R', x.base.clip),
        label: edgeLabel(x.joint.gap, x.joint.blend, x.via ? '经桥接' : ''),
        band: gapBand(x.joint.gap),
        cls: x.via ? ['ls', 'bridge'] : ['ls'],
      });
  }
  return { nodes, edges, preset: false };
}

/** The joints of the chain under the proposal: in from the stance the chain is entered from, between segments, and out to where it rests. */
export function junctions(g: MotionGraph, ix: GraphIndex, key: string, edits: ChainEdit[]): Junction[] {
  const { path } = proposed(g, ix, key, edits);
  const own = chainPath(ix, key, g.chains[key]!);
  const first = path.segs[0]!.seg.clip;
  const last = path.segs[path.segs.length - 1]!.seg.clip;
  const pairs: Array<Omit<Junction, 'flags'>> = [];
  const entry = path.entry[0] ?? own.entry[0];
  if (entry) {
    const kept = path.entry[0] === entry;
    pairs.push({ from: entry.base.clip, to: first, gap: kept ? entry.joint.gap : poseGap(g, ix, entry.base.clip, first), blend: kept ? entry.joint.blend : null, where: 'entry' });
  }
  path.segs.forEach((s, i) => {
    if (i > 0) pairs.push({ from: path.segs[i - 1]!.seg.clip, to: s.seg.clip, gap: s.joint!.gap, blend: s.joint!.blend, where: 'inner' });
  });
  const back = path.back[0] ?? own.back[0];
  if (back) {
    const to = back.via ?? back.base.clip;
    const kept = path.back[0] === back;
    pairs.push({ from: last, to, gap: kept ? back.joint.gap : poseGap(g, ix, last, to), blend: kept ? back.joint.blend : null, where: 'exit' });
  }
  return pairs.map((j) => {
    const flags: string[] = [];
    const a = posture(ix.clips.get(j.from)?.stance?.end);
    const b = posture(ix.clips.get(j.to)?.stance?.start);
    if (a && b && a !== b && ix.edges.get(`${j.from}>${j.to}`)?.kind !== 'seat') flags.push('站坐不一致');
    if (j.gap != null && j.gap > HARD_CM) flags.push('会硬切');
    return { ...j, flags };
  });
}

export interface Ghost {
  clip: string;
  gap: number;
  /** The segment it would follow; the chain's head for clips before it. */
  at: number;
}

/**
 * Clips of any group within MATCH_CM: before the chain by their leaving pose against its first frame, after it by their first
 * frame against where the chain is left (its last segment or a loop); nearest first, CAP each.
 */
export function ghosts(g: MotionGraph, ix: GraphIndex, clips: string[], shown: { p: Set<string>; s: Set<string> }) {
  const inChain = new Set(clips);
  const last = clips.length - 1;
  const sources = [last, ...clips.flatMap((c, i) => (ix.clips.get(c)?.loop && i !== last ? [i] : []))];
  const ins: Ghost[] = [];
  const outs: Ghost[] = [];
  for (const c of g.clips) {
    if (inChain.has(c.name) || !g.poses?.[c.name]) continue;
    const before = shown.p.has(c.name) ? null : poseGap(g, ix, c.name, clips[0]!);
    if (before != null && before <= MATCH_CM) ins.push({ clip: c.name, gap: before, at: 0 });
    if (shown.s.has(c.name)) continue;
    let best: Ghost | null = null;
    for (const i of sources) {
      const gap = poseGap(g, ix, clips[i]!, c.name);
      if (gap != null && (best == null || gap < best.gap)) best = { clip: c.name, gap, at: i };
    }
    if (best && best.gap <= MATCH_CM) outs.push(best);
  }
  const by = (a: Ghost, b: Ghost) => a.gap - b.gap || (a.clip < b.clip ? -1 : 1);
  return { ins: ins.sort(by).slice(0, CAP), outs: outs.sort(by).slice(0, CAP) };
}

const kindText: Record<string, string> = { exit: '打断时' };

/**
 * 链: the chain's segments under the proposal, each with its 「+」; unchanged, every clip it is entered from and goes on to (CAP
 * each, the rest in one 另 N 个 node), changed, only the stances it is entered from and rests on; then, when asked, the ghosts.
 */
export function focusLayer(g: MotionGraph, ix: GraphIndex, key: string, edits: ChainEdit[], withGhosts: boolean): Layer {
  const shippedClips = g.chains[key]!.map((s) => s.clip);
  const changed = proposedClips(key, shippedClips, edits).join('|') !== shippedClips.join('|');
  const { path } = proposed(g, ix, key, edits);
  const J = junctions(g, ix, key, edits);
  const list = path.segs.map((s) => s.seg.clip);
  const shipped = new Set(shippedClips);
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  path.segs.forEach((s, i) => {
    nodes.push(segNode(`c:${i}`, key, s.seg, i, s.role, !shipped.has(s.seg.clip)));
    if (s.seg.loop) edges.push(selfLoop(`c:${i}`, s.seg));
  });
  const jEdge = (id: string, source: string, target: string, j: Junction, cls: EdgeClass[]): GEdge => ({
    id,
    source,
    target,
    label: edgeLabel(j.gap, j.blend, j.flags.join('，')),
    band: gapBand(j.gap),
    cls: j.flags.length ? [...cls, 'flag'] : cls,
  });
  J.filter((j) => j.where === 'inner').forEach((j, i) => edges.push(jEdge(`j:${i}`, `c:${i}`, `c:${i + 1}`, j, ['spine'])));

  const shown = { p: new Set<string>(), s: new Set<string>() };
  const side = (s: 'p' | 's', clip: string) => {
    const id = `${s}:${clip}`;
    if (!shown[s].has(clip))
      nodes.push(ix.bases.has(clip) ? baseNode(ix, id, clip) : { id, kind: 'side', clip, title: shortName(clip), sub: clipSub(ix, clip) });
    shown[s].add(clip);
    return id;
  };
  if (changed) {
    for (const j of J) {
      if (j.where === 'entry') edges.push(jEdge('jin', side('p', j.from), 'c:0', j, ['ls']));
      if (j.where === 'exit') edges.push(jEdge('jout', `c:${list.length - 1}`, side('s', j.to), j, ['lt']));
    }
  } else {
    const inChain = new Set(list);
    const rests = (c: string) => Number(restOf(ix, c) != null);
    const ins = g.edges.filter((e) => e.to === list[0] && !inChain.has(e.from)).sort((a, b) => rests(b.from) - rests(a.from) || (b.gap ?? 0) - (a.gap ?? 0));
    const outs = g.edges.filter((e) => inChain.has(e.from) && !inChain.has(e.to)).sort((a, b) => rests(b.to) - rests(a.to) || (b.gap ?? 0) - (a.gap ?? 0));
    for (const [s, es] of [['p', ins], ['s', outs]] as const) {
      const far = (e: (typeof es)[number]) => (s === 'p' ? e.from : e.to);
      const kept: string[] = [];
      for (const e of es) {
        if (!kept.includes(far(e))) {
          if (kept.length >= CAP) continue;
          kept.push(far(e));
        }
        const id = side(s, far(e));
        const seg = `c:${list.indexOf(s === 'p' ? e.to : e.from)}`;
        const extra = kindText[e.kind] ?? '';
        edges.push({
          id: `r:${s}:${e.from}>${e.to}`,
          source: s === 'p' ? id : seg,
          target: s === 'p' ? seg : id,
          label: edgeLabel(e.gap, e.blend_s, extra),
          band: gapBand(e.gap),
          cls: [...(extra ? (['thin'] as const) : []), s === 'p' ? 'ls' : 'lt'],
        });
      }
      const rest = [...new Set(es.map(far))].filter((c) => !kept.includes(c));
      if (rest.length) {
        const id = `more:${s}`;
        nodes.push({ id, kind: 'more', clip: '', title: `另 ${rest.length} 个`, sub: '', names: rest });
        const seg = s === 'p' ? 'c:0' : `c:${list.length - 1}`;
        edges.push({ id: `mr:${s}`, source: s === 'p' ? id : seg, target: s === 'p' ? seg : id, label: '', band: 0, cls: ['thin'] });
      }
    }
    list.forEach((c, i) => {
      for (const e of g.edges) {
        const k = e.from === c ? list.indexOf(e.to) : -1;
        if (k >= 0 && k !== i && k !== i + 1)
          edges.push({ id: `w:${e.from}>${e.to}`, source: `c:${i}`, target: `c:${k}`, label: edgeLabel(e.gap, e.blend_s), band: gapBand(e.gap), cls: ['thin'] });
      }
    });
  }
  if (withGhosts) {
    const G = ghosts(g, ix, list, shown);
    for (const x of G.ins) {
      nodes.push({ id: `gp:${x.clip}`, kind: 'ghost', clip: x.clip, title: shortName(x.clip), sub: clipSub(ix, x.clip) });
      edges.push({ id: `ge:gp:${x.clip}`, source: `gp:${x.clip}`, target: 'c:0', label: cmText(x.gap), band: gapBand(x.gap), cls: ['ghost', 'ls'] });
    }
    for (const x of G.outs) {
      nodes.push({ id: `gs:${x.clip}`, kind: 'ghost', clip: x.clip, title: shortName(x.clip), sub: clipSub(ix, x.clip) });
      edges.push({ id: `ge:gs:${x.clip}`, source: `c:${x.at}`, target: `gs:${x.clip}`, label: cmText(x.gap), band: gapBand(x.gap), cls: ['ghost', 'lt'] });
    }
  }
  return { nodes, edges, preset: false, junctions: J };
}

/** The layer `at` names; edits are the proposal's while editing, else none. */
export function layerOf(g: MotionGraph, ix: GraphIndex, groups: ChainGroup[], at: GraphAt, edits: ChainEdit[], withGhosts: boolean): Layer {
  if (at.type === 'group') return groupLayer(g, ix, at.id, edits);
  if (at.type === 'focus' && g.chains[at.key]) return focusLayer(g, ix, at.key, edits, withGhosts);
  return overview(g, ix, groups);
}
