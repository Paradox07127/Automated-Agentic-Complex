// The pools the runtime draws chain starts from, read off the graph's clip uses. Only event pools and idle tiers can be overridden (C3 v27 rule 51).
import type { MotionPoolEntry } from '../../../bridge';
import type { MotionGroups } from '../../../bridge/motionGroups';
import type { MotionGraph } from './graph';

export type PoolKind = 'event' | 'tier' | 'activity' | 'intent' | 'speech';

export interface Pool {
  key: string;
  kind: PoolKind;
  group: string;
  /** stand, sit, … */
  posture: string;
  /** Why it cannot be overridden; null when it can. */
  locked: string | null;
  /** The clips the pack draws, with their weights (none on lists without weights). */
  entries: Array<{ clip: string; weight: number | null }>;
  /** An idle tier's first draw and later draws, in seconds idle (low, high). */
  after_s?: [number, number];
  interval_s?: [number, number];
  /** The pool does not draw any of its last this many again. */
  no_repeat?: number;
}

const KINDS = new Set<string>(['event', 'tier', 'activity', 'intent', 'speech']);
const LOCKED: Record<string, string> = {
  activity: '活动动作池由行为系统控制，不可在此修改',
  intent: '对话意图动作池不可在此修改',
  speech: '对话手势动作池不可在此修改',
};

export const editable = (kind: PoolKind, key: string) => kind === 'event' || (kind === 'tier' && /^idle\.t\d+$/.test(key));
export const asWeight = (w: number | null | undefined) => Math.min(100000, Math.max(1, Math.round(w ?? 1)));

/** Every pool with a clip the runtime draws, overridable ones first, in group order; with `mg`, also its empty-pack event pools. */
export function poolsOf(g: MotionGraph, mg?: MotionGroups): Pool[] {
  const pools = new Map<string, Pool>();
  for (const c of g.clips) {
    for (const u of c.uses) {
      if (!KINDS.has(u.type) || !u.key || !u.active) continue;
      const kind = u.type as PoolKind;
      const id = `${kind}:${u.key}`;
      let p = pools.get(id);
      if (!p) {
        const posture = kind === 'event' ? (u.posture ?? 'stand') : kind === 'tier' ? (u.stance ?? 'stand') : 'stand';
        p = { key: u.key, kind, group: u.group ?? 'idle', posture, locked: editable(kind, u.key) ? null : (LOCKED[kind] ?? '该动作池不可修改'), entries: [] };
        if (u.after_s) p.after_s = u.after_s;
        if (u.interval_s) p.interval_s = u.interval_s;
        if (u.no_repeat != null) p.no_repeat = u.no_repeat;
        pools.set(id, p);
      }
      if (!p.entries.some((e) => e.clip === c.name)) p.entries.push({ clip: c.name, weight: u.weight ?? null });
    }
  }
  const order = g.groups.map((x) => x.id);
  const rank = (p: Pool) => (order.includes(p.group) ? order.indexOf(p.group) : order.length);
  const sorted = (list: Pool[]) => list.sort((a, b) => Number(!!a.locked) - Number(!!b.locked) || rank(a) - rank(b) || a.key.localeCompare(b.key));
  const found = sorted([...pools.values()]);
  return mg ? sorted([...found, ...emptyPools(mg, g, found)]) : found;
}

/** agentd's event pools no clip of the graph uses that it proposes or refuses clips for, each in the group of its relatives. */
export function emptyPools(mg: MotionGroups, g: MotionGraph, have: Pool[] = poolsOf(g)): Pool[] {
  const out: Pool[] = [];
  for (const [key, x] of Object.entries(mg.pools)) {
    if (editable('tier', key) || have.some((p) => p.key === key) || x.pack.length > 0 || x.proposal.length + x.rejected.length === 0) continue;
    const base = key.split('@')[0]!;
    const prefix = key.split('.')[0];
    const group = g.groups.some((y) => y.id === base) ? base : (have.find((p) => p.key.split('.')[0] === prefix)?.group ?? 'idle');
    out.push({ key, kind: 'event', group, posture: x.posture, locked: null, entries: [] });
  }
  return out;
}

/** The pack's pool as an override starts it: integer weights 1–100000. */
export const packEntries = (p: Pool): MotionPoolEntry[] => p.entries.map((e) => ({ clip: e.clip, weight: asWeight(e.weight) }));

/** Chain starts in the pool's posture that it does not hold yet. */
export function candidates(g: MotionGraph, posture: string, have: MotionPoolEntry[]): string[] {
  const clips = new Map(g.clips.map((c) => [c.name, c]));
  return Object.keys(g.chains).filter((k) => (clips.get(k)?.stance?.start ?? 'stand') === posture && !have.some((e) => e.clip === k));
}
