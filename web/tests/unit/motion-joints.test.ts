// 编排's joints as plain data: a proposal's joints with their problems, and the clips within 8 cm that could follow a chain.
import { describe, expect, it } from 'vitest';
import type { ChainEdit } from '../../src/bridge';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import { indexGraph } from '../../src/pages/character/motions/chainPath';
import type { MotionGraph } from '../../src/pages/character/motions/graph';
import { ghosts, junctions } from '../../src/pages/character/motions/joints';
import { along, rangeText } from '../../src/pages/character/motions/timing';

const IDLE = 'A_clip_birch_idle_loop';
const THINK = 'A_clip_birch_customized_state_think_start';
const TO_RELAX = 'SourceUI_A_clip_birch_idle_to_relax';
const RELAX = 'A_clip_birch_relax_loop';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
const PONDER_END = 'A_clip_birch_dialog_state_think_end';
const PAT = 'A_clip_birch_customized_single_headpat';
const WAVE = 'A_clip_birch_dialog_single_wave';
const FIDGET = 'A_clip_birch_idle_fidget_01';

const pose = (dx: number) => Array.from({ length: 17 }, (_, i) => [dx, i * 10, 0]);
const still = (dx: number) => ({ start: pose(dx), end: pose(dx) });
const G0 = MOTION_GRAPH as unknown as MotionGraph;
const graph = (extra: Partial<MotionGraph> = {}) => ({ ...G0, ...extra });

describe('衔接', () => {
  it('marks a joint whose posture breaks and one far enough to cut hard', () => {
    const SIT = 'A_clip_birch_sit_state_think_loop';
    const poses = { [PONDER]: { start: pose(0), end: pose(5) }, [PONDER_LOOP]: { start: pose(6), end: pose(9) }, [PONDER_END]: { start: pose(7), end: pose(0) }, [SIT]: still(6), [WAVE]: still(60) };
    const g = graph({
      poses,
      clips: [...G0.clips, { name: SIT, group: 'session.thinking', loop: true, length_s: 2, stance: { start: 'sit', end: 'sit' }, uses: [] }],
    });
    const ix = indexGraph(g);
    const sit: ChainEdit[] = [{ op: 'replace', chain: PONDER, index: 1, clip: SIT }];
    expect(junctions(g, ix, PONDER, sit).map((j) => [j.where, j.from, j.to, j.gap, j.flags])).toEqual([
      ['entry', IDLE, PONDER, 12, []],
      ['inner', PONDER, SIT, 1, ['站坐不一致']],
      ['inner', SIT, PONDER_END, 1, ['站坐不一致']],
      ['exit', PONDER_END, IDLE, 30, []],
    ]);
    const far = junctions(g, ix, PONDER, [{ op: 'replace', chain: PONDER, index: 2, clip: WAVE }]);
    expect(far.find((j) => j.to === WAVE)).toMatchObject({ gap: 54, flags: ['会硬切'] });
  });

  it('offers the clips within 8 cm of where the chain is left, nearest first, after the segment they follow', () => {
    const poses = {
      [PONDER]: { start: pose(0), end: pose(5) },
      [PONDER_LOOP]: { start: pose(6), end: pose(9) },
      [PONDER_END]: { start: pose(7), end: pose(0) },
      [IDLE]: still(0),
      [TO_RELAX]: still(30),
      [THINK]: still(30),
      [RELAX]: still(30),
      [WAVE]: still(8),
      [PAT]: still(-8),
      [FIDGET]: still(14.5),
    };
    const g = graph({ poses });
    // WAVE is nearest the loop it would leave from, IDLE and PAT the last segment.
    expect(ghosts(g, indexGraph(g), [PONDER, PONDER_LOOP, PONDER_END]).map((x) => [x.clip, x.gap, x.at])).toEqual([
      [IDLE, 0, 2],
      [WAVE, 2, 1],
      [PAT, 8, 2],
    ]);
  });
});

describe('空闲时长轴', () => {
  it('is a square-root scale to 10 minutes and words ranges in seconds up to a minute, else minutes', () => {
    expect([0, 150, 600, 900].map(along)).toEqual([0, 0.5, 1, 1]);
    expect([rangeText([20, 40]), rangeText([25, 60]), rangeText([90, 180]), rangeText([50, 120]), rangeText([480, 600])]).toEqual([
      '20–40 s',
      '25–60 s',
      '1.5–3 m',
      '50 s–2 m',
      '8–10 m',
    ]);
  });
});
