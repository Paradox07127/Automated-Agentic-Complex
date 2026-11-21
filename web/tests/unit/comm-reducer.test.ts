import { describe, expect, it } from 'vitest';
import {
  asksFeedback,
  commReducer,
  ERROR_MS,
  FADE_MS,
  INITIAL,
  INTERRUPTED_MS,
  lingerMs,
  parseAccepted,
  parseLine,
  THINKING_MAX_MS,
  type CommState,
  type LineEvent,
} from '../../src/surfaces/desktop/comm/commReducer';

const ev = (id: string, delta: string, extra: Partial<LineEvent> = {}): LineEvent => ({
  id,
  delta,
  final: false,
  cancelled: false,
  error: null,
  lane: 'character',
  reason: null,
  ...extra,
});

const run = (s: CommState, ...lines: LineEvent[]) => lines.reduce((st, line) => commReducer(st, { type: 'line', line }), s);
const tick = (s: CommState, ms: number) => commReducer(s, { type: 'tick', dt: ms });

describe('comm reducer', () => {
  it('streams, lingers for the clamped time, fades, then is idle', () => {
    let s = run(INITIAL, ev('a', '你好'), ev('a', '，世界'));
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]).toMatchObject({ phase: 'streaming', text: '你好，世界', kind: 'main', seq: 1 });
    s = tick(s, 60_000);
    expect(s.bars[0]?.phase).toBe('streaming');
    s = run(s, ev('a', '', { final: true }));
    expect(s.bars[0]).toMatchObject({ phase: 'linger', left: 4000, total: 4000 });
    s = tick(s, 3999);
    expect(s.bars[0]?.phase).toBe('linger');
    s = tick(s, 2);
    expect(s.bars[0]?.phase).toBe('fading');
    s = tick(s, FADE_MS);
    expect(s.bars).toEqual([]);
  });

  it('linger time is clamp(3.5 s + 70 ms per character, 4 s, 15 s)', () => {
    expect(lingerMs('短')).toBe(4000);
    expect(lingerMs('一'.repeat(20))).toBe(4900);
    expect(lingerMs('一'.repeat(500))).toBe(15000);
  });

  it('an error stays 8 s and an interruption 4 s', () => {
    let s = run(INITIAL, ev('e', '读日志'), ev('e', '', { final: true, error: 'kernel_timeout' }));
    expect(s.bars[0]).toMatchObject({ phase: 'error', left: ERROR_MS });
    s = tick(s, ERROR_MS - 1);
    expect(s.bars[0]?.phase).toBe('error');
    s = tick(s, 2);
    expect(s.bars[0]?.phase).toBe('fading');
    s = run(INITIAL, ev('c', '说到一半'), ev('c', '', { final: true, cancelled: true }));
    expect(s.bars[0]).toMatchObject({ phase: 'interrupted', left: INTERRUPTED_MS });
  });

  it('an error with no text still shows; a cancelled or empty line shows nothing', () => {
    expect(run(INITIAL, ev('e', '', { final: true, error: 'x' })).bars[0]?.phase).toBe('error');
    expect(run(INITIAL, ev('c', '', { final: true, cancelled: true })).bars).toEqual([]);
    expect(run(INITIAL, ev('n', '')).bars).toEqual([]);
    expect(run(INITIAL, ev('w', '  '), ev('w', '', { final: true })).bars).toEqual([]);
  });

  it('held and pinned bars keep their time; unpinning lets it run on', () => {
    let s = run(INITIAL, ev('a', '你好', { final: true }));
    s = commReducer(s, { type: 'hold', id: 'a', held: true });
    s = tick(s, 10_000);
    expect(s.bars[0]).toMatchObject({ phase: 'linger', left: 4000 });
    s = commReducer(s, { type: 'hold', id: 'a', held: false });
    s = commReducer(s, { type: 'pin', id: 'a', pinned: true });
    s = tick(s, 60_000);
    expect(s.bars[0]).toMatchObject({ phase: 'linger', left: 4000, pinned: true });
    s = commReducer(s, { type: 'close', id: 'a' });
    expect(s.bars).toEqual([]);
  });

  it('a new main line replaces a lingering one but stacks under a pinned one', () => {
    let s = run(INITIAL, ev('a', '一', { final: true }), ev('b', '二'));
    expect(s.bars.map((b) => [b.id, b.seq])).toEqual([['b', 2]]);
    s = commReducer(s, { type: 'pin', id: 'b', pinned: true });
    s = run(s, ev('c', '三'));
    expect(s.bars.map((b) => b.id)).toEqual(['b', 'c']);
    s = run(s, ev('d', '四'));
    expect(s.bars.map((b) => b.id)).toEqual(['b', 'd']);
  });

  it('a character line while the foreground run streams is a side bar, under the main one', () => {
    let s = run(INITIAL, ev('r', '跑测试', { lane: 'agent' }), ev('s', '只读看了一眼'));
    expect(s.run).toBe('r');
    expect(s.bars.map((b) => [b.id, b.kind])).toEqual([['r', 'main'], ['s', 'side']]);
    s = run(s, ev('s2', '又问一句'));
    expect(s.bars.map((b) => [b.id, b.kind])).toEqual([['r', 'main'], ['s2', 'side']]);
    s = run(s, ev('r', '', { lane: 'agent', final: true }));
    expect(s.run).toBeNull();
    s = run(s, ev('x', '新的'));
    expect(s.bars.map((b) => [b.id, b.kind])).toEqual([['x', 'main'], ['s2', 'side']]);
  });

  it('a side-lane line is a side bar even when the panel joined after the run started', () => {
    let s = run(INITIAL, ev('s', '只读看了一眼', { lane: 'side' }));
    expect(s.run).toBeNull();
    expect(s.bars.map((b) => [b.id, b.kind])).toEqual([['s', 'side']]);
    s = run(s, ev('m', '新的'));
    expect(s.bars.map((b) => [b.id, b.kind])).toEqual([['m', 'main'], ['s', 'side']]);
  });

  it('shows at most two bars', () => {
    let s = run(INITIAL, ev('r', '跑', { lane: 'agent' }));
    s = commReducer(s, { type: 'pin', id: 'r', pinned: true });
    s = run(s, ev('s', '旁路'), ev('m', '主', { lane: 'agent' }));
    expect(s.bars).toHaveLength(2);
    expect(s.bars.map((b) => b.id)).toEqual(['r', 'm']);
  });

  it('late events of a finished line change nothing', () => {
    const s = run(INITIAL, ev('a', '完', { final: true }));
    expect(run(s, ev('a', '多余')).bars[0]?.text).toBe('完');
  });
});

const accept = (s: CommState, id: string, side = false) => commReducer(s, { type: 'accepted', id, side });

describe('comm reducer: 在想 from turn_accepted to the first word', () => {
  it('an accepted turn shows an empty thinking bar', () => {
    const s = accept(INITIAL, 't');
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]).toMatchObject({ id: 't', kind: 'main', phase: 'thinking', text: '', seq: 1 });
  });

  it('the first word turns the same bar into a streaming one', () => {
    let s = run(accept(INITIAL, 't'), ev('t', ''));
    expect(s.bars[0]?.phase).toBe('thinking');
    s = run(s, ev('t', '好的'));
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]).toMatchObject({ id: 't', phase: 'streaming', text: '好的', seq: 1 });
  });

  it('an empty final removes it, an error final shows the error, and a late accept of a finished line is ignored', () => {
    expect(run(accept(INITIAL, 't'), ev('t', '', { final: true })).bars).toEqual([]);
    expect(run(accept(INITIAL, 't'), ev('t', '', { final: true, error: 'x' })).bars[0]?.phase).toBe('error');
    const done = run(INITIAL, ev('a', '完', { final: true }));
    expect(accept(done, 'a')).toBe(done);
  });

  it('stays until the cap, then goes', () => {
    let s = tick(accept(INITIAL, 't'), THINKING_MAX_MS - 1);
    expect(s.bars[0]).toMatchObject({ phase: 'thinking', text: '' });
    s = tick(s, 2);
    expect(s.bars).toEqual([]);
  });

  it('a side turn thinks in the side bar; a new turn replaces the one thinking before it', () => {
    let s = run(INITIAL, ev('r', '跑测试', { lane: 'agent' }));
    s = accept(s, 's', true);
    expect(s.bars.map((b) => [b.id, b.kind, b.phase])).toEqual([['r', 'main', 'streaming'], ['s', 'side', 'thinking']]);
    s = accept(s, 'm');
    expect(s.bars.map((b) => [b.id, b.phase])).toEqual([['m', 'thinking']]);
    expect(commReducer(s, { type: 'close', id: 'm' }).bars).toEqual([]);
  });

  it('a line without an accepted turn streams as before', () => {
    const s = run(INITIAL, ev('a', '你好'));
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]).toMatchObject({ id: 'a', phase: 'streaming', text: '你好', kind: 'main', seq: 1 });
  });
});

describe('parseLine', () => {
  it('reads server.py _line fields', () => {
    const data = {
      line_id: 'ab12', text_delta: '嗨', intents: [], points: [], final: true, speak: true, cancelled: false, error: null,
      generation: 3, reason: { code: 'long_dwell', activity: 'coding', dwell_min: 12 }, remembered: true,
      run_id: 'ab12', lane: 'agent', conversation_id: 'c1',
    };
    expect(parseLine(JSON.stringify(data))).toEqual({
      id: 'ab12', delta: '嗨', final: true, cancelled: false, error: null, lane: 'agent',
      reason: { code: 'long_dwell', activity: 'coding', dwell_min: 12 },
    });
    expect(parseLine(JSON.stringify({ line_id: 's', text_delta: '旁', run_id: null, lane: 'side' }))?.lane).toBe('side');
    expect(parseLine('{"text_delta":"x"}')).toBeNull();
    expect(parseLine('not json')).toBeNull();
  });

  it('reads a turn_accepted event and drops a malformed one', () => {
    const data = { line_id: 'l1', conversation_id: null, source: 'voice', trace_id: 'tr1', side: true };
    expect(parseAccepted(JSON.stringify(data))).toEqual({ id: 'l1', side: true });
    expect(parseAccepted(JSON.stringify({ ...data, line_id: '' }))).toBeNull();
    expect(parseAccepted(JSON.stringify({ ...data, side: 'no' }))).toBeNull();
    expect(parseAccepted('not json')).toBeNull();
  });

  it('asks no feedback on a reply to a tap', () => {
    expect(asksFeedback({ code: 'tap' })).toBe(false);
    expect(asksFeedback({ code: 'ritual', kind: 'water' })).toBe(false);
    expect(asksFeedback({ code: 'long_dwell', dwell_min: 12 })).toBe(true);
    expect(asksFeedback(null)).toBe(false);
  });
});
