// A chain's joints and their problems, and the clips of any group close enough to follow it.
import type { ChainEdit } from '../../../bridge';
import { poseGap, proposedSegs, withJoints } from './chainEdit';
import { chainPath, type GraphIndex } from './chainPath';
import type { MotionGraph } from './graph';

export const MATCH_CM = 8;
export const HARD_CM = 40;
export const CAP = 12;

export const HARD = '会硬切';
export const POSTURE_BREAKS = '站坐不一致';

export interface Junction {
  from: string;
  to: string;
  gap: number | null;
  blend: number | null;
  flags: string[];
  where: 'entry' | 'inner' | 'exit';
}

const SIT = new Set(['sit', 'floor', 'lie']);
const posture = (s: string | undefined) => (s == null ? null : SIT.has(s) ? '坐' : '站');

/** The joints of the chain under the proposal: in from the stance the chain is entered from, between segments, and out to where it rests. */
export function junctions(g: MotionGraph, ix: GraphIndex, key: string, edits: ChainEdit[]): Junction[] {
  const segs = proposedSegs(g, ix, key, edits);
  const path = chainPath(withJoints(g, ix, segs.map((s) => s.clip)), key, segs);
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
    if (a && b && a !== b && ix.edges.get(`${j.from}>${j.to}`)?.kind !== 'seat') flags.push(POSTURE_BREAKS);
    if (j.gap != null && j.gap > HARD_CM) flags.push(HARD);
    return { ...j, flags };
  });
}

export interface Ghost {
  clip: string;
  gap: number;
  /** The segment it would follow. */
  at: number;
}

/** Clips of any group within MATCH_CM of where the chain is left (its last segment or a loop), by their first frame; nearest first, CAP of them. */
export function ghosts(g: MotionGraph, ix: GraphIndex, clips: string[]): Ghost[] {
  const inChain = new Set(clips);
  const last = clips.length - 1;
  const sources = [last, ...clips.flatMap((c, i) => (ix.clips.get(c)?.loop && i !== last ? [i] : []))];
  const outs: Ghost[] = [];
  for (const c of g.clips) {
    if (inChain.has(c.name) || !g.poses?.[c.name]) continue;
    let best: Ghost | null = null;
    for (const i of sources) {
      const gap = poseGap(g, ix, clips[i]!, c.name);
      if (gap != null && (best == null || gap < best.gap)) best = { clip: c.name, gap, at: i };
    }
    if (best && best.gap <= MATCH_CM) outs.push(best);
  }
  return outs.sort((a, b) => a.gap - b.gap || (a.clip < b.clip ? -1 : 1)).slice(0, CAP);
}
