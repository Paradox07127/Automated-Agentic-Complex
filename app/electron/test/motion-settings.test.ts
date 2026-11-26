// The pure rules behind the motion settings page: override sets, chain proposals and motion_tool
// replies and the playlist player.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeFailure } from '../src/common/bridge.ts';
import { chainArgs, chainFailure, chainProposal, chainRefused, chainRejected, chainReply, playChainArg } from '../src/common/motion-chain.ts';
import {
  loadOverrides, overridesArg, overridesEmpty, overridesJson, parseOverrides, sentOverrides, storeOverrides,
} from '../src/common/motion-overrides.ts';
import { PlaylistPlayer } from '../src/common/playlist.ts';

const SET = { chains: { c: true }, pools: { p: [{ clip: 'a', weight: 1 }, { clip: 'b', weight: 100000 }] }, blend_in: { a: 0, b: 2 } };

test('overrides: a valid set parses whole; notes are kept, counted in characters and never sent', () => {
  assert.deepEqual(parseOverrides(SET), { ...SET, notes: {} });
  const noted = parseOverrides({ ...SET, notes: { c: '字'.repeat(500), d: '👨‍👩‍👧'.repeat(500) } })!;
  assert.equal(noted.notes.c, '字'.repeat(500));
  assert.deepEqual(sentOverrides(noted), SET);
  assert.deepEqual(overridesJson(noted), { ...SET, notes: noted.notes });
  assert.deepEqual(overridesJson(parseOverrides(SET)!), SET);
  assert.equal(parseOverrides({ ...SET, notes: { c: '字'.repeat(501) } }), null);
  assert.equal(parseOverrides({ ...SET, notes: 'x' }), null);
});

test('overrides: each table holds its kind within its limits', () => {
  const keys = (n: number, v: unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, v]));
  assert.notEqual(parseOverrides({ ...SET, chains: keys(512, true) }), null);
  assert.equal(parseOverrides({ ...SET, chains: keys(513, true) }), null);
  assert.equal(parseOverrides({ ...SET, pools: keys(65, [{ clip: 'a', weight: 1 }]) }), null);
  assert.equal(parseOverrides({ ...SET, pools: { p: Array.from({ length: 65 }, (_, i) => ({ clip: `c${i}`, weight: 1 })) } }), null);
  assert.equal(parseOverrides({ ...SET, blend_in: keys(513, 1) }), null);
  assert.equal(parseOverrides({ ...SET, chains: { c: 1 } }), null);
  assert.equal(parseOverrides({ ...SET, chains: { '': true } }), null);
  assert.equal(parseOverrides({ ...SET, pools: { p: [{ clip: 'a', weight: 100001 }] } }), null);
  assert.equal(parseOverrides({ ...SET, pools: { p: [{ clip: 'a', weight: true }] } }), null);
  assert.equal(parseOverrides({ ...SET, pools: { p: ['a'] } }), null);
  assert.equal(parseOverrides({ ...SET, pools: { p: [{ clip: 'x'.repeat(129), weight: 1 }] } }), null);
  assert.equal(parseOverrides({ ...SET, blend_in: { a: -0.1 } }), null);
  assert.equal(parseOverrides({ chains: {}, pools: {} }), null);
});

test('overrides: the bridge argument is exactly chains, pools and blend_in with optional notes; the store ignores other keys', () => {
  assert.notEqual(overridesArg({ ...SET, notes: {} }), null);
  assert.equal(overridesArg({ ...SET, extra: 1 }), null);
  assert.notEqual(parseOverrides({ ...SET, extra: 1 }), null);
});

test('overrides: config.json motion_overrides keeps one set per character; other characters and keys stay', () => {
  const config = { mute: true, motion_overrides: { cedar: { chains: {}, pools: {}, blend_in: {} }, bad: { chains: 1 } } };
  const stored = storeOverrides(config, 'si', parseOverrides({ ...SET, notes: { c: 'n' } })!);
  assert.deepEqual(stored, { mute: true, motion_overrides: { ...config.motion_overrides, si: { ...SET, notes: { c: 'n' } } } });
  assert.deepEqual(loadOverrides(stored, 'si'), { ...SET, notes: { c: 'n' } });
  assert.equal(loadOverrides(stored, 'bad'), null);
  assert.equal(loadOverrides({}, 'si'), null);
  assert.equal(overridesEmpty(loadOverrides(stored, 'cedar')!), true);
  assert.equal(overridesEmpty(parseOverrides({ chains: {}, pools: {}, blend_in: {}, notes: { c: 'n' } })!), true);
  assert.equal(overridesEmpty(loadOverrides(stored, 'si')!), false);
});

const PROPOSAL = { schema: 'endfield-motion-chain-proposal/v1', character: 'si', package_sha256: 'ab'.repeat(32),
  edits: [{ op: 'set', clip: 'a', next: null, exit: 'b', hold: 0 }, { op: 'replace', chain: 'c', index: 1, clip: 'd' },
    { op: 'insert', chain: 'c', index: 2, clip: 'e' }, { op: 'blend', clip: 'a', seconds: 2 }] };

test('chain proposal: exactly its four keys, the v1 schema, a lowercase sha256 and one or more edits', () => {
  assert.equal(chainProposal(PROPOSAL), PROPOSAL);
  assert.equal(chainProposal({ ...PROPOSAL, schema: 'v2' }), null);
  assert.equal(chainProposal({ ...PROPOSAL, character: 'x'.repeat(65) }), null);
  assert.equal(chainProposal({ ...PROPOSAL, package_sha256: 'AB'.repeat(32) }), null);
  assert.equal(chainProposal({ ...PROPOSAL, edits: [] }), null);
  assert.equal(chainProposal({ ...PROPOSAL, note: '' }), null);
});

test('chain proposal: each edit has exactly its op\'s keys and types', () => {
  const edit = (e: Record<string, unknown>) => chainProposal({ ...PROPOSAL, edits: [e] });
  assert.equal(edit({ op: 'set', clip: 'a' }), null);
  assert.equal(edit({ op: 'set', clip: 'a', other: 1 }), null);
  assert.equal(edit({ op: 'set', clip: 'a', hold: -1 }), null);
  assert.notEqual(edit({ op: 'set', clip: 'a', hold: null }), null);
  assert.equal(edit({ op: 'set', next: 'b' }), null);
  assert.equal(edit({ op: 'replace', chain: 'c', index: 0, clip: 'd' }), null);
  assert.equal(edit({ op: 'insert', chain: 'c', index: 1.5, clip: 'd' }), null);
  assert.equal(edit({ op: 'insert', chain: 'c', index: 1, clip: 'd', hold: 1 }), null);
  assert.equal(edit({ op: 'blend', clip: 'a', seconds: 2.1 }), null);
  assert.equal(edit({ op: 'remove', clip: 'a' }), null);
});

test('chain tool: arguments, the failure line of stderr, and the reply a check or an apply prints', () => {
  assert.deepEqual(chainArgs('/lib', 'si', '/tmp/p.json', true, '/host'),
    ['chain', '--library', '/lib', '--character', 'si', '--proposal', '/tmp/p.json', '--check', '--validate-with', '/host']);
  assert.equal(chainArgs('/lib', 'si', '/tmp/p.json', false, '/host').includes('--check'), false);
  const failure = (stderr: string) => { const f = chainFailure(stderr); return [f.code, f.detail]; };
  assert.deepEqual(failure('warn\n{"reason": "chain_refused", "detail": "[]"}\n'), ['chain_refused', '[]']);
  assert.deepEqual(failure('{"reason": "busy"}'), ['busy', '']);
  assert.deepEqual(failure('{"reason": "odd", "detail": "x"}\n'), ['internal', '{"reason": "odd", "detail": "x"}']);
  assert.deepEqual(failure(`${'x'.repeat(3000)}\n`), ['internal', 'x'.repeat(1999)]);
  assert.deepEqual(chainReply('{"ok": false, "problems": [], "graph_changes": {}}', true), { ok: false, problems: [], graph_changes: {} });
  assert.deepEqual(chainReply('{"ok": true, "character": "si", "version": "1"}', false), { ok: true, character: 'si', version: '1' });
  assert.throws(() => chainReply('{"ok": true, "character": "si", "version": "1"}', true), (e) => e instanceof BridgeFailure && e.code === 'internal');
  assert.throws(() => chainReply('{"ok": false, "character": "si", "version": "1"}', false), BridgeFailure);
  assert.throws(() => chainReply('progress 50%', false), BridgeFailure);
});

test('play_chain: argument, and the codes of a rejected play and an ack error', () => {
  assert.deepEqual(playChainArg({ start: 'a' }), { start: 'a', speed: 1 });
  assert.deepEqual(playChainArg({ start: 'a', speed: 0.5 }), { start: 'a', speed: 0.5 });
  assert.throws(() => playChainArg({ start: 'a', speed: null }), BridgeFailure);
  const code = (f: BridgeFailure) => [f.code, f.detail];
  assert.deepEqual(code(chainRejected('missing')), ['missing', '该动作缺少资源文件']);
  assert.deepEqual(code(chainRejected('switching')), ['switching', '正在切换角色']);
  assert.deepEqual(code(chainRefused('timeout')), ['failed', '角色渲染进程无响应']);
  assert.deepEqual(code(chainRefused('unsupported')), ['not_implemented', '当前版本角色不支持动作设置']);
  assert.deepEqual(code(chainRefused('busy')), ['failed', '正在切换角色，设置未保存']);
});

/** A player whose sends the test reads; `sends` false makes each send fail. */
function player(o: { loop?: boolean; sends?: boolean } = {}) {
  const sent: { id: string; speed: number; loop: boolean }[] = [], stopped: string[] = [];
  const p = new PlaylistPlayer({
    send: (id, speed, loop) => (o.sends === false ? null : (sent.push({ id, speed, loop }), `p${sent.length}`)),
    stop: (playId) => stopped.push(playId), supportsLoop: () => o.loop ?? false,
  });
  return { p, sent, stopped };
}

test('playlist off: each completed item plays the next; the last one ends the list', () => {
  const { p, sent } = player();
  p.start({ items: ['a', 'b'], loop: 'off', speed: 2 }, 0);
  assert.deepEqual(p.state, { kind: 'playing', index: 0, playId: 'p1' });
  p.received('p1', 'started', null);
  p.received('p1', 'completed', null);
  assert.deepEqual(p.state, { kind: 'playing', index: 1, playId: 'p2' });
  p.received('p2', 'completed', null);
  assert.deepEqual(p.state, { kind: 'idle' });
  assert.deepEqual(sent, [{ id: 'a', speed: 2, loop: false }, { id: 'b', speed: 2, loop: false }]);
});

test('playlist all wraps to the first item; one plays the same item again, with loop only when she lists action_loop', () => {
  const all = player();
  all.p.start({ items: ['a', 'b'], loop: 'all', speed: 1 }, 1);
  all.p.received('p1', 'completed', null);
  assert.deepEqual(all.p.state, { kind: 'playing', index: 0, playId: 'p2' });
  const one = player();
  one.p.start({ items: ['a', 'b'], loop: 'one', speed: 1 }, 1);
  one.p.received('p1', 'completed', null);
  assert.deepEqual(one.sent.map((s) => [s.id, s.loop]), [['b', false], ['b', false]]);
  const looping = player({ loop: true });
  looping.p.start({ items: ['a'], loop: 'one', speed: 1 }, 0);
  assert.equal(looping.sent[0]!.loop, true);
});

test('playlist: a rejected or interrupted item ends the list with its reason; other play ids and phases change nothing', () => {
  for (const phase of ['rejected', 'interrupted']) {
    const { p } = player();
    p.start({ items: ['a', 'b'], loop: 'all', speed: 1 }, 0);
    p.received('other', 'completed', null);
    p.received('p1', 'started', null);
    assert.equal(p.state.kind, 'playing');
    p.received('p1', phase, 'user');
    assert.deepEqual(p.state, { kind: 'idle' });
    assert.equal(p.lastReason, 'user');
    p.start({ items: ['a'], loop: 'off', speed: 1 }, 0);
    assert.equal(p.lastReason, null);
  }
});

test('playlist: stop sends stop_action only when she lists action_loop; a character change ends it; nothing sent or no item stays idle', () => {
  const plain = player();
  plain.p.start({ items: ['a'], loop: 'off', speed: 1 }, 0);
  plain.p.stop();
  assert.deepEqual([plain.p.state, plain.stopped], [{ kind: 'idle' }, []]);
  const looping = player({ loop: true });
  looping.p.start({ items: ['a'], loop: 'one', speed: 1 }, 0);
  looping.p.stop();
  assert.deepEqual(looping.stopped, ['p1']);
  looping.p.stop();
  assert.deepEqual(looping.stopped, ['p1']);
  looping.p.start({ items: ['a'], loop: 'one', speed: 1 }, 0);
  looping.p.characterChanged();
  assert.deepEqual(looping.p.state, { kind: 'idle' });
  const failing = player({ sends: false });
  failing.p.start({ items: ['a'], loop: 'off', speed: 1 }, 0);
  assert.deepEqual(failing.p.state, { kind: 'idle' });
  plain.p.start({ items: ['a'], loop: 'off', speed: 1 }, 3);
  assert.deepEqual(plain.p.state, { kind: 'idle' });
});

test('playlist position: the index in the saved list, or null when a single slot plays an action the list lacks', () => {
  const { p } = player();
  assert.equal(p.position(['a']), null);
  p.start({ items: ['a', 'b'], loop: 'off', speed: 1 }, 1);
  assert.deepEqual(p.position(['a', 'b']), { index: 1, id: 'b' });
  assert.deepEqual(p.position(['b', 'c']), { index: 0, id: 'b' });
  p.start({ items: ['z'], loop: 'off', speed: 1 }, 0);
  assert.deepEqual(p.position(['a', 'b']), { index: null, id: 'z' });
});
