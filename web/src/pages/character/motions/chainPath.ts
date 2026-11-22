// A chain laid out left to right: the stance it is entered from, its segments, the stances it comes back to, and the gap and blend at each joint.
import { shortName, type GraphClip, type GraphEdge, type GraphSeg, type MotionGraph } from './graph';

/** 1 ≤8 cm, 2 ≤25, 3 ≤40, 4 over 40; 0 unmeasured. */
export type GapBand = 0 | 1 | 2 | 3 | 4;
export const gapBand = (gap: number | null | undefined): GapBand =>
  gap == null ? 0 : gap <= 8 ? 1 : gap <= 25 ? 2 : gap <= 40 ? 3 : 4;
/** The legend's words for each band, in a row: ≤8 ≤25 ≤40 >40 cm 未测. */
export const BAND_TEXT: Record<GapBand, string> = { 0: '未测', 1: '≤8', 2: '≤25', 3: '≤40', 4: '>40 cm' };

export interface Base {
  clip: string;
  family: string;
  hub: boolean;
}

export interface Joint {
  gap: number | null;
  blend: number | null;
}

export interface PathSeg {
  seg: GraphSeg;
  role: string;
  /** The joint into this segment: from the entry stance for the first. */
  joint: Joint | null;
}

export interface ChainPath {
  key: string;
  entry: Array<{ base: Base; joint: Joint }>;
  segs: PathSeg[];
  /** Where it comes to rest; `via` names the bridge it passes on the way. */
  back: Array<{ base: Base; joint: Joint; via: string | null }>;
}

export interface GraphIndex {
  clips: Map<string, GraphClip>;
  edges: Map<string, GraphEdge>;
  /** Base clip → its family. */
  bases: Map<string, Base>;
  /** Bridge clip → the base it ends on. */
  bridges: Map<string, string>;
}

const FAMILY: Record<string, string> = { dialog: '对话站姿', relax: '放松站姿', overview: '总览站姿', sit: '坐姿', floor: '坐地上' };
export const baseLabel = (b: Base) => FAMILY[b.family] ?? b.family;

export function indexGraph(g: MotionGraph): GraphIndex {
  const clips = new Map(g.clips.map((c) => [c.name, c]));
  const edges = new Map(g.edges.map((e) => [`${e.from}>${e.to}`, e]));
  const bases = new Map<string, Base>();
  for (const c of g.clips) {
    const u = c.uses.find((x) => x.type === 'base');
    if (u?.key) bases.set(c.name, { clip: c.name, family: u.key, hub: !!u.hub });
  }
  const byFamily = new Map([...bases.values()].map((b) => [b.family, b.clip]));
  const bridges = new Map<string, string>();
  for (const c of g.clips) {
    const to = c.uses.find((x) => x.type === 'bridge')?.key?.split('>')[1];
    const base = to ? byFamily.get(to) : undefined;
    if (base) bridges.set(c.name, base);
  }
  return { clips, edges, bases, bridges };
}

function role(seg: GraphSeg, i: number, n: number): string {
  if (seg.loop) return '循环';
  if (n === 1) return '单次';
  const b = shortName(seg.clip);
  if (/_to_/.test(b)) return '过渡';
  if (/(_|^)start(_\d+)?$/.test(b)) return '起';
  if (/_end(_\d+)?$/.test(b)) return '收';
  return i === 0 ? '起' : i === n - 1 ? '收' : '接';
}

const hubFirst = <T extends { base: Base }>(xs: T[]) => xs.sort((a, b) => Number(b.base.hub) - Number(a.base.hub));
const joint = (e: GraphEdge | undefined, blend?: number | null): Joint => ({ gap: e?.gap ?? null, blend: e?.blend_s ?? blend ?? null });

export function chainPath(ix: GraphIndex, key: string, all: GraphSeg[]): ChainPath {
  // A chain that ends on a base comes back to that base; it is not a segment of its own.
  const restsOnBase = all.length > 1 && ix.bases.has(all[all.length - 1]!.clip);
  const segs = restsOnBase ? all.slice(0, -1) : all;
  const first = segs[0]!.clip;
  const last = segs[segs.length - 1]!.clip;
  const entry = hubFirst(
    [...ix.bases.values()].flatMap((base) => {
      const e = ix.edges.get(`${base.clip}>${first}`);
      return e && base.clip !== first ? [{ base, joint: joint(e) }] : [];
    }),
  );
  const back = restsOnBase
    ? [{ base: ix.bases.get(all[all.length - 1]!.clip)!, joint: joint(ix.edges.get(`${last}>${all[all.length - 1]!.clip}`), all[all.length - 1]!.blend_in_s), via: null }]
    : hubFirst(
        [...ix.edges.values()].flatMap((e) => {
          if (e.from !== last) return [];
          const base = ix.bases.get(e.to) ?? ix.bases.get(ix.bridges.get(e.to) ?? '');
          return base && base.clip !== last ? [{ base, joint: joint(e), via: ix.bases.has(e.to) ? null : e.to }] : [];
        }),
      );
  return {
    key,
    entry,
    segs: segs.map((seg, i) => ({
      seg,
      role: role(seg, i, segs.length),
      joint: i === 0 ? null : joint(ix.edges.get(`${segs[i - 1]!.clip}>${seg.clip}`), seg.blend_in_s),
    })),
    back,
  };
}

const sec = (x: number) => `${Math.round(x * 100) / 100} s`;

export const lengthText = (seg: GraphSeg) => (seg.length_s == null ? '—' : seg.loop ? `一圈 ${sec(seg.length_s)}` : sec(seg.length_s));
