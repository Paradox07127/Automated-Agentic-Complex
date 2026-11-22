// The fake bridge's `GET /characters/:character_id/motion-groups`: two pools of the mock graph's `si` with proposals and refusals.
import { CHARACTERS } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/types';
import type { MotionGroups } from '../motionGroups';

const P = 'A_clip_birch_';

const POOLS: MotionGroups['pools'] = {
  'idle.t1': {
    posture: 'stand',
    pack: [{ clip: `${P}idle_fidget_01`, weight: 1 }],
    proposal: [
      { clip: `${P}ui_relax_sp`, weight: 1, why: 'token:ui_relax' },
      { clip: `${P}uiteam_idle_loop`, weight: 1, why: 'structure:idle_loop' },
      { clip: `${P}customized_state_stretch_start`, weight: 1, why: 'structure:chain' },
    ],
    rejected: [{ clip: `${P}customized_state_sit_loop`, reason: 'stance_mismatch' }],
  },
  'session.thinking': {
    posture: 'stand',
    pack: [
      { clip: `${P}customized_state_think_start`, weight: 1 },
      { clip: `${P}dialog_state_think_start`, weight: 2 },
    ],
    proposal: [{ clip: `${P}dialog_single_think`, weight: 1, why: 'token:dialog_single' }],
    rejected: [{ clip: `${P}dialog_state_think_fall`, reason: 'no_return' }],
  },
};

const EXCLUDED: MotionGroups['excluded'] = [
  { clip: `${P}battle_skill_01`, reason: 'battle' },
  { clip: `${P}battle_attack_02`, reason: 'battle' },
  { clip: `${P}intro_cs_01`, reason: 'cutscene' },
  { clip: `${P}shared_walk_loop`, reason: 'locomotion' },
];

const UNCLASSIFIED = [`${P}receivemoney_hold`, `${P}serving_tray`];

const pools = Object.values(POOLS);
export const MOTION_GROUPS: MotionGroups = {
  character: 'si',
  pools: POOLS,
  excluded: EXCLUDED,
  unclassified: UNCLASSIFIED,
  counts: {
    clips: pools.reduce((n, p) => n + p.pack.length + p.proposal.length + p.rejected.length, 0) + EXCLUDED.length + UNCLASSIFIED.length,
    pooled: pools.reduce((n, p) => n + p.pack.length, 0),
    proposed: pools.reduce((n, p) => n + p.proposal.length, 0),
    rejected: pools.reduce((n, p) => n + p.rejected.length, 0),
    excluded: EXCLUDED.length,
    unclassified: UNCLASSIFIED.length,
  },
};

/** Answers for `character()` only, as agentd does; a current character without the fixture has no motion graph. */
export const motionGroupRoutes = (character: () => string): MockRoute[] => [
  {
    method: 'GET',
    path: '/characters/:character_id/motion-groups',
    handler: ({ params }) => {
      const id = params.character_id;
      if (!CHARACTERS.some((c) => c.id === id)) return { status: 404, body: { error: 'unknown_character' } };
      if (id !== character()) return { status: 409, body: { error: 'not_current' } };
      if (id !== MOTION_GROUPS.character) return { status: 404, body: { error: 'motion_graph_missing' } };
      return { status: 200, body: MOTION_GROUPS };
    },
  },
];
