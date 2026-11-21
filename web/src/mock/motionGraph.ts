// GET /characters/:character_id/motion-graph (C6): a small `endfield-motion-graph/v1` for `si`; `voice_a` has a pack without one.
import { CHARACTERS } from './fixtures';
import type { MockRoute } from './types';

const THINK = 'A_clip_birch_customized_state_think_start';
const IDLE = 'A_clip_birch_idle_loop';
const RELAX = 'A_clip_birch_relax_loop';
const TO_RELAX = 'SourceUI_A_clip_birch_idle_to_relax';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
const PONDER_END = 'A_clip_birch_dialog_state_think_end';
const PAT = 'A_clip_birch_customized_single_headpat';
const WAVE = 'A_clip_birch_dialog_single_wave';
const FIDGET = 'A_clip_birch_idle_fidget_01';

const STAND = { start: 'stand', end: 'stand' };
const edge = (from: string, to: string, kind: string, gap: number | null, blend_s = 0.25) => ({ id: `edge:${from}>${to}`, from, to, kind, gap, blend_s });

export const MOTION_GRAPH = {
  schema: 'endfield-motion-graph/v1',
  character: 'si',
  package_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  crossfade_s: 0.25,
  runtime: { excluded_families: { value: [], source: 'ActorMotionPolicy.excludedFamilies' } },
  groups: [
    { id: 'base', title: '基础站姿与桥接', parent: null },
    { id: 'session.thinking', title: '思考', parent: 'session' },
    { id: 'click', title: '点击与进场', parent: null },
    { id: 'idle', title: '空闲各档', parent: null },
  ],
  clips: [
    {
      name: IDLE, group: 'base', length_s: 4, loop: true, origin: 'game', stance: STAND,
      uses: [{ type: 'base', key: 'dialog', group: 'base', active: true, hub: true }], chains: [THINK],
    },
    {
      name: THINK, group: 'session.thinking', length_s: 1.2, loop: false, next: IDLE, origin: 'game', stance: STAND,
      uses: [{ type: 'event', key: 'session.thinking', group: 'session.thinking', via: 'events', weight: 1, active: true }], chains: [THINK],
    },
    {
      name: RELAX, group: 'base', length_s: 3, loop: true, origin: 'game', stance: STAND,
      uses: [{ type: 'base', key: 'relax', group: 'base', active: true }], chains: [TO_RELAX],
    },
    {
      name: TO_RELAX, group: 'base', length_s: 0.8, loop: false, next: RELAX, origin: 'game', stance: STAND,
      uses: [{ type: 'bridge', key: 'dialog>relax', group: 'base', active: true }], chains: [TO_RELAX],
    },
    {
      name: PONDER, group: 'session.thinking', length_s: 1.5, loop: false, next: PONDER_LOOP, origin: 'game', stance: STAND,
      uses: [
        { type: 'event', key: 'session.thinking', group: 'session.thinking', via: 'events', weight: 2, active: true },
        { type: 'activity', key: 'think', group: 'session.thinking', via: 'activities', active: true, moods: ['calm'] },
      ],
      chains: [PONDER],
    },
    {
      name: PONDER_LOOP, group: 'session.thinking', length_s: 2, loop: true, next: PONDER_END, origin: 'game', stance: STAND,
      uses: [{ type: 'chain', key: PONDER, group: 'session.thinking', active: true }], chains: [PONDER],
    },
    {
      name: PONDER_END, group: 'session.thinking', length_s: 1.1, loop: false, origin: 'game', stance: STAND,
      uses: [{ type: 'chain', key: PONDER, group: 'session.thinking', active: true }], chains: [PONDER],
    },
    {
      name: PAT, group: 'click', length_s: 2.2, loop: false, origin: 'imported', stance: STAND,
      uses: [{ type: 'event', key: 'click.head', group: 'click', via: 'events', weight: 1, active: true }], chains: [PAT],
    },
    {
      name: WAVE, group: 'click', length_s: 1.9, loop: false, origin: 'game', stance: STAND,
      uses: [
        { type: 'event', key: 'click.single', group: 'click', via: 'motion_library', active: false, reason: 'click.single 只从 events 池抽（playClickReaction）' },
        { type: 'action', key: 'wave', name: '挥手', section: 'react', active: false, reason: '手动动作面板' },
      ],
      chains: [WAVE],
    },
    {
      name: FIDGET, group: 'idle', length_s: 2.6, loop: false, origin: 'game', stance: STAND,
      uses: [{ type: 'tier', key: 'idle.t1', group: 'idle', via: 'idle_tiers', weight: 1, stance: 'stand', active: true }], chains: [FIDGET],
    },
  ],
  edges: [
    edge(THINK, IDLE, 'next', 1.8),
    edge(IDLE, THINK, 'start', 2),
    edge(IDLE, TO_RELAX, 'base', 0.5),
    edge(TO_RELAX, RELAX, 'bridge', 6.4),
    edge(IDLE, PONDER, 'start', 12, 0.4),
    edge(PONDER, PONDER_LOOP, 'next', 3.1),
    edge(PONDER_LOOP, PONDER_END, 'next', 0.4),
    edge(PONDER_END, IDLE, 'end', 30, 0.81),
    edge(PONDER_END, TO_RELAX, 'end', 45),
    edge(IDLE, PAT, 'start', null),
    edge(PAT, IDLE, 'end', 5),
    edge(IDLE, WAVE, 'start', 9, 0.26),
    edge(WAVE, IDLE, 'end', 7),
    edge(IDLE, FIDGET, 'start', 3),
    edge(FIDGET, IDLE, 'end', 4),
  ],
  chains: {
    [THINK]: [{ clip: THINK, length_s: 1.2, loop: false }, { clip: IDLE, length_s: 4, loop: true, note: '站姿循环，一直播', blend_in_s: 0.25 }],
    [TO_RELAX]: [{ clip: TO_RELAX, length_s: 0.8, loop: false }, { clip: RELAX, length_s: 3, loop: true, note: '站姿循环，一直播', blend_in_s: 0.25 }],
    [PONDER]: [
      { clip: PONDER, length_s: 1.5, loop: false },
      { clip: PONDER_LOOP, length_s: 2, loop: true, hold_range_s: [2, 2], note: '循环 2 s', blend_in_s: 0.25 },
      { clip: PONDER_END, length_s: 1.1, loop: false, blend_in_s: 0.25 },
    ],
    [PAT]: [{ clip: PAT, length_s: 2.2, loop: false }],
    [WAVE]: [{ clip: WAVE, length_s: 1.9, loop: false }],
    [FIDGET]: [{ clip: FIDGET, length_s: 2.6, loop: false }],
  },
  counts: { clips: 10, edges: 15, chains: 6 },
};

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/characters/:character_id/motion-graph',
    handler: ({ params }) => {
      if (!CHARACTERS.some((c) => c.id === params.character_id)) return { status: 404, body: { error: 'unknown_character' } };
      if (params.character_id !== MOTION_GRAPH.character) return { status: 404, body: { error: 'motion_graph_missing' } };
      return { status: 200, body: MOTION_GRAPH };
    },
  },
];
