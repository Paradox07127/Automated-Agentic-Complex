// The 动作线 demo: four and a half minutes before `now` with every motion-lane kind. An idle loop; she goes quiet
// while you type and a hover is refused; a pat with its chain exit; your own play cuts her loop and refuses the
// chooser's next one; a spoken turn with a gesture; the renderer drops mid-line; she picks her loop again.
import { isoWithOffset } from '../../domain';
import type { LaneEvent } from './lanes';

type Row = [id: string, trace: string, cause: string | null, s: number, kind: string, attrs: Record<string, unknown>, status?: string, producer?: string];

const text = (head: string) => ({ len: head.length, head: head.slice(0, 8) });

const ROWS: Row[] = [
  // The chooser's idle loop.
  ['c1', 'tk1', null, -262, 'motion.chosen', { clip: 'idle_stand_a', why: 'idle.t1 stand tierPick', layer: 'base', behavior_id: 'b1', t_s: 0 }],
  ['d1', 'tk1', 'c1', -261.98, 'behavior.dispatched', { behavior_id: 'b1', behavior_type: 'clip' }],
  ['m1', 'tk1', 'd1', -261.7, 'motion.state', { origin: 'agent', phase: 'started', clip: 'idle_stand_a', behavior_id: 'b1' }],
  ['r1', 'tk1', 'd1', -261.69, 'behavior.receipt', { behavior_id: 'b1', behavior_type: 'clip', phase: 'running', reason: null }],
  // You start typing: quiet, a walk to the edge, a hover refused by the stage.
  ['s1', 'sg1', null, -236, 'signal.changed', { source: 'coarse', key: 'typing', value: true, revision: 41 }],
  ['g1', 'sg1', 's1', -235.99, 'stage.changed', { from: 'normal', to: 'quiet', revision: 41 }],
  ['d2', 'sg1', 'g1', -235.9, 'behavior.dispatched', { behavior_id: 'b2', behavior_type: 'short_walk' }],
  ['r2', 'sg1', 'd2', -235.5, 'behavior.receipt', { behavior_id: 'b2', behavior_type: 'short_walk', phase: 'running', reason: null }],
  ['r3', 'sg1', 'd2', -231.2, 'behavior.receipt', { behavior_id: 'b2', behavior_type: 'short_walk', phase: 'completed', reason: null }],
  ['s2', 'sg2', null, -214, 'signal.changed', { source: 'pointer', key: 'hover', value: true, revision: null }],
  ['c2', 'sg2', 's2', -213.98, 'motion.chosen', { clip: 'hover_look', why: 'event user.hover', layer: 'overlay', behavior_id: null, t_s: 0 }],
  ['x1', 'sg2', 's2', -213.97, 'behavior.refused', { behavior_type: 'clip', trigger_source: 'pointer', trigger_event: 'user.hover', priority: 0, channels: ['overlay'], reason: 'stage' }, 'blocked'],
  ['s3', 'sg3', null, -206, 'signal.changed', { source: 'pointer', key: 'hover', value: false, revision: null }],
  ['s4', 'sg4', null, -182, 'signal.changed', { source: 'coarse', key: 'typing', value: false, revision: 42 }],
  ['g2', 'sg4', 's4', -181.99, 'stage.changed', { from: 'quiet', to: 'normal', revision: 42 }],
  // A pat and the exit of its chain.
  ['s5', 'sg5', null, -160, 'signal.changed', { source: 'touch', key: 'pat', value: true, revision: null }],
  ['c3', 'sg5', 's5', -159.98, 'motion.chosen', { clip: 'pat_start', why: 'event pat.head', layer: 'overlay', behavior_id: 'b3', t_s: 0 }],
  ['d3', 'sg5', 'c3', -159.97, 'behavior.dispatched', { behavior_id: 'b3', behavior_type: 'clip' }],
  ['m2', 'sg5', 'd3', -159.7, 'motion.state', { origin: 'agent', phase: 'started', clip: 'pat_start', behavior_id: 'b3' }],
  ['m3', 'sg5', 'd3', -157.6, 'motion.state', { origin: 'agent', phase: 'cycle_end', clip: 'pat_start', behavior_id: 'b3' }],
  ['s6', 'sg6', null, -153, 'signal.changed', { source: 'touch', key: 'pat', value: false, revision: null }],
  ['c4', 'sg6', 's6', -152.98, 'motion.chosen', { clip: 'pat_end', why: 'exit of pat_start', layer: 'overlay', behavior_id: 'b4', t_s: 0 }],
  ['d4', 'sg6', 'c4', -152.97, 'behavior.dispatched', { behavior_id: 'b4', behavior_type: 'clip' }],
  ['m4', 'sg6', 'd4', -151.1, 'motion.state', { origin: 'agent', phase: 'ended', clip: 'pat_end', behavior_id: 'b4' }],
  // Your own play: her loop ends with user_play, the chooser's next loop is refused until it ends.
  ['m5', 'up1', null, -128, 'motion.state', { origin: 'user', phase: 'started', clip: 'wave', behavior_id: null }],
  ['r4', 'tk1', 'd1', -127.98, 'behavior.receipt', { behavior_id: 'b1', behavior_type: 'clip', phase: 'cancelled', reason: 'user_play' }, 'cancelled'],
  ['c5', 'tk2', 'm5', -118, 'motion.chosen', { clip: 'idle_stand_b', why: 'idle.t2 stand tierPick', layer: 'base', behavior_id: null, t_s: 0 }],
  ['x2', 'tk2', 'm5', -117.99, 'behavior.refused', { behavior_type: 'clip', trigger_source: 'chooser', trigger_event: 'idle', priority: 0, channels: ['base'], reason: 'user_play' }, 'blocked'],
  ['m6', 'up1', null, -112, 'motion.state', { origin: 'user', phase: 'ended', clip: 'wave', behavior_id: null }],
  ['c6', 'tk3', 'm6', -111.9, 'motion.chosen', { clip: 'idle_stand_a', why: 'idle.t0 stand tierPick', layer: 'base', behavior_id: 'b5', t_s: 0 }],
  ['d5', 'tk3', 'c6', -111.89, 'behavior.dispatched', { behavior_id: 'b5', behavior_type: 'clip' }],
  ['m7', 'tk3', 'd5', -111.6, 'motion.state', { origin: 'agent', phase: 'started', clip: 'idle_stand_a', behavior_id: 'b5' }],
  ['r5', 'tk3', 'd5', -111.59, 'behavior.receipt', { behavior_id: 'b5', behavior_type: 'clip', phase: 'running', reason: null }],
  // A spoken turn with the chooser's speech gesture.
  ['i1', 'tu1', null, -86, 'input.received', { source: 'text', text: text('今天的会几点开始') }],
  ['l1', 'tu1', 'i1', -84.2, 'line.parsed', { line_id: 'ln1', intents: ['answer'], target: null, first_sentence_only: false, text: text('三点，还有四十分钟') }],
  ['p1', 'tu1', 'l1', -84.1, 'speech.requested', { speech_id: 'sp1', line_id: 'ln1', clause_id: null, text: text('三点，还有四十分钟') }],
  ['p2', 'tu1', 'p1', -83.7, 'speech.first_audio', { speech_id: 'sp1', clause_id: null }, 'ok', 'tts'],
  ['p3', 'tu1', 'p2', -83.5, 'playback.started', { speech_id: 'sp1', clause_id: null }, 'ok', 'avatar'],
  ['c7', 'tu1', 'p3', -83.4, 'motion.chosen', { clip: 'talk_gesture_a', why: 'speech.gesture', layer: 'overlay', behavior_id: 'b6', t_s: 0 }],
  ['d6', 'tu1', 'c7', -83.39, 'behavior.dispatched', { behavior_id: 'b6', behavior_type: 'clip' }],
  ['m8', 'tu1', 'd6', -83.1, 'motion.state', { origin: 'agent', phase: 'started', clip: 'talk_gesture_a', behavior_id: 'b6' }],
  ['p4', 'tu1', 'p1', -82.6, 'speech.finished', { speech_id: 'sp1', clause_id: null, total_samples: 52800 }, 'ok', 'tts'],
  ['m9', 'tu1', 'd6', -80.9, 'motion.state', { origin: 'agent', phase: 'ended', clip: 'talk_gesture_a', behavior_id: 'b6' }],
  ['p5', 'tu1', 'p3', -80.2, 'playback.ended', { speech_id: 'sp1', clause_id: null }, 'ok', 'avatar'],
  // The renderer drops mid-line: playback and her loop end with connection_lost.
  ['i2', 'tu2', null, -52, 'input.received', { source: 'voice', text: text('那提醒我一下') }],
  ['l2', 'tu2', 'i2', -50.1, 'line.parsed', { line_id: 'ln2', intents: ['answer'], target: null, first_sentence_only: false, text: text('好，两点五十叫你') }],
  ['p6', 'tu2', 'l2', -50, 'speech.requested', { speech_id: 'sp2', line_id: 'ln2', clause_id: null, text: text('好，两点五十叫你') }],
  ['p7', 'tu2', 'p6', -49.6, 'speech.first_audio', { speech_id: 'sp2', clause_id: null }, 'ok', 'tts'],
  ['p8', 'tu2', 'p7', -49.4, 'playback.started', { speech_id: 'sp2', clause_id: null }, 'ok', 'avatar'],
  ['p9', 'tu2', 'p8', -48.3, 'playback.interrupted', { speech_id: 'sp2', clause_id: null, reason: 'connection_lost', planned_ms: 2600 }, 'cancelled', 'avatar'],
  ['r6', 'tk3', 'd5', -48.29, 'behavior.receipt', { behavior_id: 'b5', behavior_type: 'clip', phase: 'cancelled', reason: 'connection_lost' }, 'cancelled'],
  // Back: she picks her loop again; a look to the left.
  ['c8', 'tk4', null, -31, 'motion.chosen', { clip: 'idle_stand_a', why: 'idle.t0 stand tierPick', layer: 'base', behavior_id: 'b7', t_s: 0 }],
  ['d7', 'tk4', 'c8', -30.99, 'behavior.dispatched', { behavior_id: 'b7', behavior_type: 'clip' }],
  ['m10', 'tk4', 'd7', -30.6, 'motion.state', { origin: 'agent', phase: 'started', clip: 'idle_stand_a', behavior_id: 'b7' }],
  ['r7', 'tk4', 'd7', -30.59, 'behavior.receipt', { behavior_id: 'b7', behavior_type: 'clip', phase: 'running', reason: null }],
  ['s7', 'sg7', null, -14, 'signal.changed', { source: 'attention', key: 'side', value: 'left', revision: null }],
  ['c9', 'sg7', 's7', -13.98, 'motion.chosen', { clip: 'look_left', why: 'event look.left', layer: 'overlay', behavior_id: 'b8', t_s: 0 }],
  ['d8', 'sg7', 'c9', -13.97, 'behavior.dispatched', { behavior_id: 'b8', behavior_type: 'clip' }],
  ['m11', 'sg7', 'd8', -13.6, 'motion.state', { origin: 'agent', phase: 'started', clip: 'look_left', behavior_id: 'b8' }],
  ['m12', 'sg7', 'd8', -11.2, 'motion.state', { origin: 'agent', phase: 'ended', clip: 'look_left', behavior_id: 'b8' }],
];

/** The demo stretch, ending a few seconds before `now`. */
export function lanesDemo(now: number): LaneEvent[] {
  return ROWS.map(([id, trace, cause, s, kind, attrs, status = 'ok', producer = 'agentd']) => ({
    event_id: id,
    trace_id: trace,
    causation_id: cause,
    kind,
    status,
    producer,
    t_wall: isoWithOffset(now + Math.round(s * 1000)),
    attrs,
  }));
}
