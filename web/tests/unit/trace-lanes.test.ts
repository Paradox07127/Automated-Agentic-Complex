// 动作线: which lane each T1 kind is drawn in, and the causation walk over the demo stretch.
import { describe, expect, it } from 'vitest';
import { causesOf, effectsOf, laneOf, lanesOf, LANE_ORDER, pack, SOURCES, toneOf, walkOf, type LaneEvent } from '../../src/pages/trace/lanes';
import { lanesDemo } from '../../src/pages/trace/lanesDemo';

const NOW = Date.parse('2026-11-22T10:00:00-05:00');
const demo = lanesDemo(NOW);
const ids = (list: LaneEvent[]) => list.map((e) => e.event_id);
const ev = (kind: string, attrs: Record<string, unknown> = {}) => ({ kind, attrs });

describe('laneOf', () => {
  it('puts signal.changed in the lane of its source, in source order before the rest', () => {
    for (const s of SOURCES) expect(laneOf(ev('signal.changed', { source: s }))).toBe(`in.${s}`);
    expect(laneOf(ev('signal.changed', { source: 'window_title' }))).toBeNull();
    expect(LANE_ORDER).toEqual([...SOURCES.map((s) => `in.${s}`), 'stage', 'decide', 'body', 'speech']);
  });

  it('draws stage, decisions, renderer feedback and speech in their lanes and no other kind', () => {
    const want: Record<string, string | null> = {
      'stage.changed': 'stage',
      'motion.chosen': 'decide',
      'behavior.refused': 'decide',
      'behavior.dispatched': 'decide',
      'motion.state': 'body',
      'behavior.receipt': 'body',
      'speech.requested': 'speech',
      'speech.first_audio': 'speech',
      'speech.finished': 'speech',
      'playback.started': 'speech',
      'playback.ended': 'speech',
      'playback.interrupted': 'speech',
      'playback.buffering': 'speech',
      'playback.resumed': 'speech',
      'playback.degraded': 'speech',
      'input.received': null,
      'line.parsed': null,
      'behavior.ticked': null,
      'gate.decided': null,
      'motion.started': null,
      'model.finished': null,
    };
    for (const [kind, lane] of Object.entries(want)) expect(laneOf(ev(kind)), kind).toBe(lane);
  });

  it('shows an input lane only when the stretch has its source', () => {
    expect(lanesOf(demo)).toEqual(['in.coarse', 'in.pointer', 'in.attention', 'in.touch', 'stage', 'decide', 'body', 'speech']);
    expect(lanesOf([])).toEqual(['stage', 'decide', 'body', 'speech']);
  });
});

describe('the demo stretch', () => {
  it('has every motion-lane kind, a refusal, your own play and a renderer disconnect', () => {
    const kinds = new Set(demo.map((e) => e.kind));
    for (const k of ['signal.changed', 'stage.changed', 'behavior.refused', 'motion.chosen', 'motion.state', 'behavior.dispatched', 'behavior.receipt']) expect(kinds).toContain(k);
    expect(demo.some((e) => e.kind === 'behavior.refused' && e.attrs.reason === 'stage')).toBe(true);
    expect(demo.some((e) => e.kind === 'motion.state' && e.attrs.origin === 'user')).toBe(true);
    expect(demo.some((e) => e.kind === 'behavior.receipt' && e.attrs.reason === 'connection_lost')).toBe(true);
    expect(demo.every((e) => e.causation_id == null || demo.some((c) => c.event_id === e.causation_id))).toBe(true);
    expect(Math.max(...demo.map((e) => Date.parse(e.t_wall)))).toBeLessThan(NOW);
    expect(Math.min(...demo.map((e) => Date.parse(e.t_wall)))).toBeGreaterThan(NOW - 5 * 60_000);
  });

  it('marks refusals and failures bad, your own play user', () => {
    const by = new Map(demo.map((e) => [e.event_id, e]));
    expect(toneOf(by.get('x1')!)).toBe('bad');
    expect(toneOf(by.get('r6')!)).toBe('bad');
    expect(toneOf(by.get('m5')!)).toBe('user');
    expect(toneOf(by.get('x2')!)).toBe('user');
    expect(toneOf(by.get('d1')!)).toBe('ok');
  });
});

describe('the causation walk', () => {
  const w = walkOf(demo);

  it('goes up from the renderer feedback through the dispatch and the choice to the input', () => {
    expect(ids(causesOf(w, 'm2'))).toEqual(['d3', 'c3', 's5']);
    expect(ids(causesOf(w, 'd2'))).toEqual(['g1', 's1']);
    expect(ids(causesOf(w, 'x1'))).toEqual(['s2']);
    expect(causesOf(w, 's1')).toEqual([]);
  });

  it('goes up past the lanes to the turn that started the speech', () => {
    expect(ids(causesOf(w, 'm8'))).toEqual(['d6', 'c7', 'p3', 'p2', 'p1', 'l1', 'i1']);
  });

  it('goes down to everything an input caused, nearest first', () => {
    expect(ids(effectsOf(w, 's1'))).toEqual(['g1', 'd2', 'r2', 'r3']);
    expect(ids(effectsOf(w, 's2'))).toEqual(['c2', 'x1']);
    expect(ids(effectsOf(w, 'd1'))).toEqual(['m1', 'r1', 'r4']);
    expect(ids(effectsOf(w, 'm5'))).toEqual(['c5', 'x2']);
    expect(effectsOf(w, 'm12')).toEqual([]);
  });

  it('stops at an event outside the stretch and at a loop', () => {
    const a: LaneEvent = { event_id: 'a', trace_id: 't', causation_id: 'b', kind: 'motion.chosen', status: 'ok', producer: 'agentd', t_wall: demo[0]!.t_wall, attrs: {} };
    const b: LaneEvent = { ...a, event_id: 'b', causation_id: 'a' };
    const lone: LaneEvent = { ...a, event_id: 'c', causation_id: 'gone' };
    const loop = walkOf([a, b, lone]);
    expect(ids(causesOf(loop, 'a'))).toEqual(['b']);
    expect(ids(effectsOf(loop, 'a'))).toEqual(['b']);
    expect(causesOf(loop, 'c')).toEqual([]);
  });
});

describe('pack', () => {
  it('moves a mark that would cover the one before to the next sub-row, at most `rows`', () => {
    expect(pack([0, 0.001, 0.002, 0.003, 0.5], 0.01, 3)).toEqual([0, 1, 2, 2, 0]);
  });
});
