// The motion settings' reading of agentd's `endfield-motion-graph/v1` (pipeline motion_graph.py): groups, chains and each clip's uses.
import { AgentdCallError, get } from '../../../bridge/agentd';

export interface GraphUse {
  type: string;
  key?: string;
  group?: string | null;
  active?: boolean;
  /** The 手动动作 row's name on `action` uses. */
  name?: string;
  /** Relative draw weight on pool uses. */
  weight?: number;
  /** An event pool's posture when not standing. */
  posture?: string;
  /** An idle tier's posture. */
  stance?: string;
  /** The base family's hub on `base` uses. */
  hub?: boolean;
  /** Why the runtime skips it. */
  reason?: string;
}

/** game: the pack's own frames; imported: added by a motion import; generated: a generated motion. */
export type ClipOrigin = 'game' | 'imported' | 'generated';

export interface GraphClip {
  name: string;
  group: string;
  length_s?: number;
  loop?: boolean;
  uses: GraphUse[];
  origin?: ClipOrigin;
  stance?: { start?: string; end?: string };
  /** The pose families its first and last frames match. */
  family?: { start?: string; end?: string };
  /** The pack's blend into it. */
  blend_in_s?: number;
  /** A held loop's hold in seconds. */
  hold_s?: number;
}

/** A clip's 17 key-bone points of its first and last frame, aligned, in cm. */
export interface GraphPose {
  start: number[][];
  end: number[][];
}

/** One segment of a chain; `blend_in_s` is the blend into it from the segment before. */
export interface GraphSeg {
  clip: string;
  length_s?: number | null;
  loop?: boolean;
  held?: boolean;
  hold_range_s?: [number, number] | null;
  note?: string | null;
  blend_in_s?: number | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  /** Measured key-bone gap in cm; null where a pose could not be measured. */
  gap: number | null;
  blend_s: number | null;
}

export interface MotionGraph {
  character: string;
  /** The pack's default blend in seconds. */
  crossfade_s?: number;
  groups: Array<{ id: string; title: string; parent: string | null }>;
  clips: GraphClip[];
  edges: GraphEdge[];
  /** Chain key (its first clip) → its segments in play order. */
  chains: Record<string, GraphSeg[]>;
  poses?: Record<string, GraphPose>;
  /** The installed pack's character.json sha256, which a structure proposal names; agentd's reply does not carry it yet. */
  package_sha256?: string;
}

/** GET /characters/:id/motion-graph; null when the installed pack has none (404 motion_graph_missing). */
export async function readGraph(character: string): Promise<MotionGraph | null> {
  try {
    return await get<MotionGraph>(`/characters/${character}/motion-graph`);
  } catch (e) {
    if (e instanceof AgentdCallError && e.code === 'motion_graph_missing') return null;
    throw e;
  }
}

/** Uses that make a clip part of the base stances: the avatar answers `required` when such a chain is turned off. */
const REQUIRED_USES = new Set(['base', 'bridge', 'binding']);

export interface ChainRow {
  key: string;
  label: string;
  /** The chain's clips without the character prefix. */
  clips: string[];
  group: string;
  groupTitle: string;
  /** On in the pack: a clip of the chain has a live use other than another chain's. */
  def: boolean;
  required: boolean;
  /** A clip of the chain is not the game's own. */
  isNew: boolean;
}

export interface ChainGroup {
  id: string;
  title: string;
  rows: ChainRow[];
}

export const shortName = (clip: string) => clip.replace(/^(SourceUI_)?A_(actor|monster|clip)_[a-z0-9]+_/, '');

/** One section per graph group that starts a chain, in the graph's order; default-on rows first. */
export function chainGroups(g: MotionGraph): ChainGroup[] {
  const clips = new Map(g.clips.map((c) => [c.name, c]));
  const title = new Map(g.groups.map((x) => [x.id, x.title]));
  const rows: ChainRow[] = Object.entries(g.chains).map(([key, segs]) => {
    const head = clips.get(key);
    const members = segs.map((s) => clips.get(s.clip));
    const group = head?.group ?? 'unwired';
    return {
      key,
      label: head?.uses.find((u) => u.type === 'action' && u.name)?.name ?? shortName(key),
      clips: segs.map((s) => shortName(s.clip)),
      group,
      groupTitle: title.get(group) ?? group,
      def: members.some((c) => c?.uses.some((u) => u.active && !(u.type === 'chain' && u.key !== key))),
      required: !!head?.uses.some((u) => REQUIRED_USES.has(u.type)),
      isNew: members.some((c) => c?.origin != null && c.origin !== 'game'),
    };
  });
  const order = [...g.groups.map((x) => x.id), ...rows.map((r) => r.group)].filter((id, i, all) => all.indexOf(id) === i);
  return order
    .map((id) => ({
      id,
      title: title.get(id) ?? id,
      rows: rows.filter((r) => r.group === id).sort((a, b) => Number(b.def) - Number(a.def) || a.clips[0]!.localeCompare(b.clips[0]!)),
    }))
    .filter((x) => x.rows.length > 0);
}

export type ChainFilter = 'all' | 'on' | 'off' | 'chg' | 'new';

/** The row passes the filter (on, off and 已改 read the value shown) and the search (any clip, the label or the group). */
export function shows(r: ChainRow, on: boolean, f: ChainFilter, q: string): boolean {
  const pass = f === 'all' || (f === 'on' ? on : f === 'off' ? !on : f === 'chg' ? on !== r.def : r.isNew);
  const qq = q.trim().toLowerCase();
  return pass && (!qq || [r.key, r.label, r.groupTitle, ...r.clips].some((s) => s.toLowerCase().includes(qq)));
}
