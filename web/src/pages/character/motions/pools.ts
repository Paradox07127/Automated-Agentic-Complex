// The pools the runtime draws chain starts from, read off the graph's clip uses. Only event pools and idle tiers can be overridden (C3 v27 rule 51).
import type { MotionPoolEntry } from '../../../bridge';
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
}

const KINDS = new Set<string>(['event', 'tier', 'activity', 'intent', 'speech']);
const LOCKED: Record<string, string> = {
  activity: '活动的池子由行为决定，不能在这里改',
  intent: '说话意图的池子不能在这里改',
  speech: '说话手势的池子不能在这里改',
};

export const editable = (kind: PoolKind, key: string) => kind === 'event' || (kind === 'tier' && /^idle\.t\d+$/.test(key));
export const asWeight = (w: number | null | undefined) => Math.min(100000, Math.max(1, Math.round(w ?? 1)));

/** Every pool with a clip the runtime draws, overridable ones first, in group order. */
export function poolsOf(g: MotionGraph): Pool[] {
  const pools = new Map<string, Pool>();
  for (const c of g.clips) {
    for (const u of c.uses) {
      if (!KINDS.has(u.type) || !u.key || !u.active) continue;
      const kind = u.type as PoolKind;
      const id = `${kind}:${u.key}`;
      let p = pools.get(id);
      if (!p) {
        const posture = kind === 'event' ? (u.posture ?? 'stand') : kind === 'tier' ? (u.stance ?? 'stand') : 'stand';
        p = { key: u.key, kind, group: u.group ?? 'idle', posture, locked: editable(kind, u.key) ? null : (LOCKED[kind] ?? '这个池子不能改'), entries: [] };
        pools.set(id, p);
      }
      if (!p.entries.some((e) => e.clip === c.name)) p.entries.push({ clip: c.name, weight: u.weight ?? null });
    }
  }
  const order = g.groups.map((x) => x.id);
  const rank = (p: Pool) => (order.includes(p.group) ? order.indexOf(p.group) : order.length);
  return [...pools.values()].sort((a, b) => Number(!!a.locked) - Number(!!b.locked) || rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/** The pack's pool as an override starts it: integer weights 1–100000. */
export const packEntries = (p: Pool): MotionPoolEntry[] => p.entries.map((e) => ({ clip: e.clip, weight: asWeight(e.weight) }));

/** Chain starts in the pool's posture that it does not hold yet. */
export function candidates(g: MotionGraph, posture: string, have: MotionPoolEntry[]): string[] {
  const clips = new Map(g.clips.map((c) => [c.name, c]));
  return Object.keys(g.chains).filter((k) => (clips.get(k)?.stance?.start ?? 'stand') === posture && !have.some((e) => e.clip === k));
}
