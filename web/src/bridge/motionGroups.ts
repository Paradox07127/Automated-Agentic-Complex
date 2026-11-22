// `GET /characters/<id>/motion-groups` (C6): agentd's proposals of which clips join which pool, for the current character only.
import { get, seg } from './agentd';
import type { MotionPoolEntry } from './motionOverrides';

/** A clip agentd proposes for a pool; `why` names the rule, e.g. `token:dialog_single`. */
export interface MotionGroupProposal extends MotionPoolEntry {
  why: string;
}

/** A clip a rule maps to the pool that the pool's posture refuses, e.g. `no_return`. */
export interface MotionGroupRefusal {
  clip: string;
  reason: string;
}

export interface MotionGroupPool {
  posture: string;
  /** The pool as the pack has it. */
  pack: MotionPoolEntry[];
  proposal: MotionGroupProposal[];
  rejected: MotionGroupRefusal[];
}

/** Every clip of the graph is in exactly one of a pack pool, a proposal, a rejected list, `excluded` or `unclassified`. */
export interface MotionGroups {
  character: string;
  pools: Record<string, MotionGroupPool>;
  /** `reason` is the exclusion rule's, e.g. `battle`. */
  excluded: MotionGroupRefusal[];
  unclassified: string[];
  counts: { clips: number; pooled: number; proposed: number; rejected: number; excluded: number; unclassified: number };
}

/** Another character than the current one answers 409 `not_current`. */
export const motionGroups = (character: string) => get<MotionGroups>(`/characters/${seg(character)}/motion-groups`);
