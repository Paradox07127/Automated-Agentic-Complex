// 动作 → 图's layers as plain data: 总览's merged edges, a group's chains end to end, a chain's sides capped at 12, the clips
// within 8 cm that could join it, and the problems of a proposal's joints.
import { describe, expect, it } from 'vitest';
import type { ChainEdit } from '../../src/bridge';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import { indexGraph } from '../../src/pages/character/motions/chainPath';
import { chainGroups, type MotionGraph } from '../../src/pages/character/motions/graph';
import { focusLayer, groupLayer, junctions, overview, type GEdge } from '../../src/pages/character/motions/graphView/elements';

const IDLE = 'A_clip_birch_idle_loop';
const RELAX = 'A_clip_birch_relax_loop';
const THINK = 'A_clip_birch_customized_state_think_start';
const TO_RELAX = 'SourceUI_A_clip_birch_idle_to_relax';
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
const from = (edges: GEdge[], source: string) => edges.filter((e) => e.source === source && e.target !== source);

describe('总览', () => {
  it('merges the edges from one stance into one group into one, labelled with the count and the largest gap', () => {
    const g = graph();
    const ix = indexGraph(g);
    const L = overview(g, ix, chainGroups(g));
    const agg = L.edges.filter((e) => e.cls.includes('agg'));
    expect(agg.map((e) => [e.source, e.target, e.label]).sort()).toEqual(
      [
        [`b:${IDLE}`, 'g:session.thinking', '2 条 │ 最大 12 cm'],
        [`b:${IDLE}`, 'g:click', '2 条 │ 最大 9 cm'],
        [`b:${IDLE}`, 'g:idle', '1 条 │ 最大 3 cm'],
      ].sort(),
    );
    const stance = L.edges.filter((e) => e.cls.includes('bb'));
    expect(stance.map((e) => [e.source, e.target, e.label])).toEqual([[`b:${IDLE}`, `b:${RELAX}`, '经桥接\n0.5 cm │ 0.25 s']]);
    expect(L.preset).toBe(true);
    const x = (id: string) => L.nodes.find((n) => n.id === id)!.pos!.x;
    expect(x(`b:${IDLE}`)).toBeLessThan(x('g:click'));
  });
});

describe('分组', () => {
  it('draws a chain from the stance it is entered from, through its segments, to the stances it comes back to', () => {
    const g = graph();
    const ix = indexGraph(g);
    const L = groupLayer(g, ix, 'session.thinking', []);
    const walk = [`L:${IDLE}`];
    for (let next = from(L.edges, walk[0]!).find((e) => e.target.startsWith(`k:${PONDER}`)); next; ) {
      walk.push(next.target);
      next = from(L.edges, next.target).find((e) => e.target.startsWith('k:'));
    }
    expect(walk).toEqual([`L:${IDLE}`, `k:${PONDER}|0`, `k:${PONDER}|1`, `k:${PONDER}|2`]);
    expect(from(L.edges, `k:${PONDER}|2`).map((e) => [e.target, e.label])).toEqual([
      [`R:${IDLE}`, '30 cm │ 0.81 s'],
      [`R:${RELAX}`, '经桥接\n45 cm │ 0.25 s'],
    ]);
    const self = L.edges.filter((e) => e.cls.includes('self'));
    expect(self.map((e) => [e.source, e.target, e.label])).toEqual([[`k:${PONDER}|1`, `k:${PONDER}|1`, '持续 2 s']]);
    expect(L.nodes.find((n) => n.id === `k:${PONDER}|1`)).toMatchObject({ kind: 'seg', clip: PONDER_LOOP, chain: PONDER, index: 1 });
  });
});

describe('链', () => {
  it('shows at most 12 clips on each side and folds the rest into one 另 N 个 node', () => {
    const more = Array.from({ length: 14 }, (_, i) => `A_clip_birch_extra_${String(i).padStart(2, '0')}`);
    const g = graph({
      clips: [...G0.clips, ...more.map((name) => ({ name, group: 'click', uses: [] }))],
      edges: [
        ...G0.edges,
        ...more.flatMap((m, i) => [
          { from: m, to: PONDER, kind: 'next', gap: i, blend_s: 0.25 },
          { from: PONDER_END, to: m, kind: 'next', gap: i, blend_s: 0.25 },
        ]),
      ],
    });
    const L = focusLayer(g, indexGraph(g), PONDER, [], false);
    const pred = L.nodes.filter((n) => n.id.startsWith('p:'));
    const succ = L.nodes.filter((n) => n.id.startsWith('s:'));
    expect(pred.length).toBe(12);
    expect(succ.length).toBe(12);
    // Stances first, then the farthest: IDLE before, the bridge to RELAX (45 cm) and IDLE (30 cm) after.
    expect(pred[0]!.clip).toBe(IDLE);
    expect(succ.slice(0, 2).map((n) => n.clip)).toEqual([TO_RELAX, IDLE]);
    expect(L.nodes.find((n) => n.id === 'more:p')).toMatchObject({ title: '另 3 个', names: [more[2], more[1], more[0]] });
    expect(L.nodes.find((n) => n.id === 'more:s')).toMatchObject({ title: '另 4 个' });
    expect(L.nodes.filter((n) => n.kind === 'seg').map((n) => n.id)).toEqual(['c:0', 'c:1', 'c:2']);
  });

  it('adds the clips within 8 cm as candidates: before by their leaving pose, after by their first frame', () => {
    const poses = {
      [PONDER]: { start: pose(0), end: pose(5) },
      [PONDER_LOOP]: { start: pose(6), end: pose(9) },
      [PONDER_END]: { start: pose(7), end: pose(0) },
      // Already on the graph before and after the chain.
      [IDLE]: still(0),
      [TO_RELAX]: still(30),
      [THINK]: still(30),
      [RELAX]: still(30),
      [WAVE]: still(8),
      [PAT]: still(-8),
      [FIDGET]: still(14.5),
    };
    const g = graph({ poses });
    const L = focusLayer(g, indexGraph(g), PONDER, [], true);
    const ghost = (prefix: string) => L.edges.filter((e) => e.id.startsWith(prefix)).map((e) => [e.source, e.target, e.label]);
    expect(ghost('ge:gp:')).toEqual([
      [`gp:${PAT}`, 'c:0', '8 cm'],
      [`gp:${WAVE}`, 'c:0', '8 cm'],
    ]);
    // WAVE is nearest the loop it would leave from, PAT the last segment.
    expect(ghost('ge:gs:')).toEqual([
      ['c:1', `gs:${WAVE}`, '2 cm'],
      ['c:2', `gs:${PAT}`, '8 cm'],
    ]);
    expect(L.nodes.some((n) => n.clip === FIDGET)).toBe(false);
    expect(focusLayer(g, indexGraph(g), PONDER, [], false).nodes.some((n) => n.kind === 'ghost')).toBe(false);
  });

  it('marks a joint whose posture breaks and one far enough to cut hard', () => {
    const SIT = 'A_clip_birch_sit_state_think_loop';
    const poses = { [PONDER]: { start: pose(0), end: pose(5) }, [PONDER_LOOP]: { start: pose(6), end: pose(9) }, [PONDER_END]: { start: pose(7), end: pose(0) }, [SIT]: still(6), [WAVE]: still(60) };
    const g = graph({
      poses,
      clips: [...G0.clips, { name: SIT, group: 'session.thinking', loop: true, length_s: 2, stance: { start: 'sit', end: 'sit' }, uses: [] }],
    });
    const ix = indexGraph(g);
    const sit: ChainEdit[] = [{ op: 'replace', chain: PONDER, index: 1, clip: SIT }];
    const J = junctions(g, ix, PONDER, sit);
    expect(J.map((j) => [j.where, j.from, j.to, j.gap, j.flags])).toEqual([
      ['entry', IDLE, PONDER, 12, []],
      ['inner', PONDER, SIT, 1, ['站坐不一致']],
      ['inner', SIT, PONDER_END, 1, ['站坐不一致']],
      ['exit', PONDER_END, IDLE, 30, []],
    ]);
    const L = focusLayer(g, ix, PONDER, sit, false);
    expect(L.nodes.find((n) => n.id === 'c:1')).toMatchObject({ clip: SIT, changed: true });
    expect(L.edges.find((e) => e.id === 'j:0')!.label).toBe('站坐不一致\n1 cm │ — s');
    // Changed, the sides are only the stances it is entered from and rests on.
    expect(L.nodes.filter((n) => n.id.startsWith('p:') || n.id.startsWith('s:')).map((n) => n.id)).toEqual([`p:${IDLE}`, `s:${IDLE}`]);

    const far = junctions(g, ix, PONDER, [{ op: 'replace', chain: PONDER, index: 2, clip: WAVE }]);
    expect(far.find((j) => j.to === WAVE)).toMatchObject({ gap: 54, flags: ['会硬切'] });
  });
});
