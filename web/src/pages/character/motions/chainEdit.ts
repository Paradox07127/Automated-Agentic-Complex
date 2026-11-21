// 链详情「编辑结构」: a structure proposal's edits laid over a chain, the clips that can take a segment, and the gaps of new joints
// measured from the graph's 17 key-bone poses as motion_graph.py measures them.
import type { ChainEdit } from '../../../bridge';
import type { GraphIndex } from './chainPath';
import type { GraphSeg, MotionGraph } from './graph';

/** pose_family.gap_cm over two aligned poses already in cm: the largest key-bone distance, to 0.1 cm. */
export function keyBoneGap(a: number[][], b: number[][]): number {
  const far = a.reduce((m, p, i) => {
    const q = b[i]!;
    return Math.max(m, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!));
  }, 0);
  return Math.round(far * 10) / 10;
}

/** motion_graph.py measured_gap: from the pose `from` is left (a loop's first frame, else its last) to `to`'s first frame; null unmeasured. */
export function poseGap(g: MotionGraph, ix: GraphIndex, from: string, to: string): number | null {
  const a = g.poses?.[from];
  const b = g.poses?.[to];
  if (!a || !b) return null;
  return keyBoneGap(ix.clips.get(from)?.loop ? a.start : a.end, b.start);
}

/** The chain's clips once the proposal's replace and insert edits on it are applied in order. */
export function proposedClips(key: string, clips: string[], edits: ChainEdit[]): string[] {
  const out = [...clips];
  for (const e of edits) {
    if (e.op === 'replace' && e.chain === key) out[e.index] = e.clip;
    else if (e.op === 'insert' && e.chain === key) out.splice(e.index, 0, e.clip);
  }
  return out;
}

/** The hold the proposal gives a clip; undefined when it does not set one. */
export function holdOf(edits: ChainEdit[], clip: string): number | null | undefined {
  const e = edits.find((x) => x.op === 'set' && x.clip === clip && 'hold' in x);
  return e?.op === 'set' ? e.hold : undefined;
}

/** The chain's segments under the proposal: the graph's own where a clip stays, else one made from the clip's row. */
export function proposedSegs(g: MotionGraph, ix: GraphIndex, key: string, edits: ChainEdit[]): GraphSeg[] {
  const own = g.chains[key]!;
  return proposedClips(key, own.map((s) => s.clip), edits).map((clip) => {
    const c = ix.clips.get(clip);
    const seg = own.find((s) => s.clip === clip) ?? { clip, length_s: c?.length_s ?? null, loop: !!c?.loop, blend_in_s: c?.blend_in_s ?? null };
    const hold = holdOf(edits, clip);
    return hold === undefined ? seg : { ...seg, hold_range_s: hold === null ? null : [hold, hold] };
  });
}

/** The index with a measured edge for every joint of `clips` the graph has no edge for. */
export function withJoints(g: MotionGraph, ix: GraphIndex, clips: string[]): GraphIndex {
  const edges = new Map(ix.edges);
  clips.slice(1).forEach((to, i) => {
    const from = clips[i]!;
    if (!edges.has(`${from}>${to}`)) edges.set(`${from}>${to}`, { from, to, kind: 'proposed', gap: poseGap(g, ix, from, to), blend_s: null });
  });
  return { ...ix, edges };
}

export interface Candidate {
  clip: string;
  /** Gap from the segment before; null unmeasured. */
  before: number | null;
  /** Gap into the segment after; undefined when there is none. */
  after?: number | null;
}

/**
 * Clips that can take segment `index` of `clips`: the same stance and pose families as it, not already in the chain; nearest first
 * by the worse of its two joints (unmeasured last), then by name.
 */
export function candidates(g: MotionGraph, ix: GraphIndex, clips: string[], index: number): Candidate[] {
  const cur = ix.clips.get(clips[index]!);
  const prev = clips[index - 1]!;
  const next = clips[index + 1];
  const worst = (c: Candidate) => Math.max(c.before ?? Infinity, c.after === undefined ? 0 : (c.after ?? Infinity));
  return g.clips
    .filter(
      (c) =>
        !clips.includes(c.name) &&
        c.stance?.start === cur?.stance?.start &&
        c.stance?.end === cur?.stance?.end &&
        c.family?.start === cur?.family?.start &&
        c.family?.end === cur?.family?.end,
    )
    .map((c): Candidate => ({
      clip: c.name,
      before: poseGap(g, ix, prev, c.name),
      ...(next !== undefined ? { after: poseGap(g, ix, c.name, next) } : {}),
    }))
    .sort((a, b) => worst(a) - worst(b) || (a.clip < b.clip ? -1 : 1));
}

const sameSlot = (a: ChainEdit | undefined, chain: string, index: number) =>
  (a?.op === 'replace' || a?.op === 'insert') && a.chain === chain && a.index === index;

/**
 * The edits with `e` added: a replace of the segment the chain's last edit put in takes that edit's clip instead, and a hold
 * takes the place of the clip's earlier one.
 */
export function addEdit(edits: ChainEdit[], e: ChainEdit): ChainEdit[] {
  if (e.op === 'set') {
    const at = edits.findIndex((x) => x.op === 'set' && x.clip === e.clip);
    return at < 0 ? [...edits, e] : edits.map((x, i) => (i === at ? { ...x, ...e } : x));
  }
  if (e.op === 'replace') {
    const at = edits.findLastIndex((x) => (x.op === 'replace' || x.op === 'insert') && x.chain === e.chain);
    if (sameSlot(edits[at], e.chain, e.index)) return edits.map((x, i) => (i === at ? { ...x, clip: e.clip } : x));
  }
  return [...edits, e];
}
