// TurnMarks (src/common/turn-marks.ts): which marks a 202 and the feed's `line` deltas give.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Mark, TurnMarks } from '../src/common/turn-marks.ts';

function setup() {
  let t = 0;
  const marks: [string, string, string, number, Mark][] = [];
  const turnMarks = new TurnMarks((kind, trace, turn, generation, at) => marks.push([kind, trace, turn, generation, at]),
    () => ({ wall: 1000 + ++t, monoMs: t }));
  return { turnMarks, marks, kinds: () => marks.map(([k, , turn]) => `${k} ${turn}`) };
}

test('a 202 marks ui.submitted at the send and ui.ack now; the first line delta with text marks ui.first_text once', () => {
  const s = setup();
  s.turnMarks.accepted('l1', 't1', 4, { wall: 999, monoMs: 0 });
  assert.deepEqual(s.marks, [['ui.submitted', 't1', 'l1', 4, { wall: 999, monoMs: 0 }], ['ui.ack', 't1', 'l1', 4, { wall: 1001, monoMs: 1 }]]);
  s.turnMarks.feed({ event: 'line', id: '1', data: JSON.stringify({ line_id: 'l1', text_delta: '' }) });
  s.turnMarks.feed({ event: 'announce', id: '2', data: JSON.stringify({ line_id: 'l1', text_delta: '好' }) });
  assert.equal(s.marks.length, 2, 'no text yet, and not a line');
  s.turnMarks.feed({ event: 'line', id: '3', data: JSON.stringify({ line_id: 'l1', text_delta: '好' }) });
  s.turnMarks.line('l1', true);
  assert.deepEqual(s.kinds(), ['ui.submitted l1', 'ui.ack l1', 'ui.first_text l1']);
});

test('an agentd that sends no trace_id or generation marks nothing', () => {
  const s = setup();
  s.turnMarks.accepted('l1', null, 4, { wall: 1, monoMs: 1 });
  s.turnMarks.acceptedBody(202, { line_id: 'l2', trace_id: 't2' }, { wall: 1, monoMs: 1 });
  s.turnMarks.acceptedBody(200, { command: 'stop' }, { wall: 1, monoMs: 1 });
  s.turnMarks.line('l1', true);
  assert.deepEqual(s.marks, []);
});

test('at most 32 lines wait for their first text; the oldest goes first', () => {
  const s = setup();
  for (let i = 0; i <= TurnMarks.maxWaiting; i++) s.turnMarks.accepted(`l${i}`, `t${i}`, i, { wall: 1, monoMs: 1 });
  s.turnMarks.line('l0', true);
  s.turnMarks.line(`l${TurnMarks.maxWaiting}`, true);
  assert.deepEqual(s.kinds().filter((k) => k.startsWith('ui.first_text')), [`ui.first_text l${TurnMarks.maxWaiting}`]);
});

test('only a 202 with a line id is a line agentd took', () => {
  const s = setup();
  const body = { line_id: 'l1', trace_id: 't1', generation: 2 };
  s.turnMarks.acceptedBody(200, body, { wall: 1, monoMs: 0 });
  s.turnMarks.acceptedBody(202, { trace_id: 't1', generation: 2 }, { wall: 1, monoMs: 0 });
  s.turnMarks.acceptedBody(202, null, { wall: 1, monoMs: 0 });
  assert.deepEqual(s.kinds(), []);
  s.turnMarks.acceptedBody(202, body, { wall: 1, monoMs: 0 });
  assert.deepEqual(s.kinds(), ['ui.submitted l1', 'ui.ack l1']);
});
