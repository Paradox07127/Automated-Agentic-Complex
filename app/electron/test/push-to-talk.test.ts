// 按住说话 (src/common/push-to-talk.ts), on a fake clock, a fake platform helper
// and a fake agentd: one test per branch. Nothing here reaches a microphone, a hot key or a permission prompt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type HelperAnswer, HINT, normalizeTranscript, PushToTalk, pushToTalkState, rejectedHint, speechLocale, type VoiceHint,
} from '../src/common/push-to-talk.ts';
import { TurnMarks } from '../src/common/turn-marks.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });

type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);
type AgentdAnswer = { status: number; body: unknown } | 'down' | (() => Promise<{ status: number; body: unknown }>)
  | (() => { status: number; body: unknown });

/** A promise settled from outside, for an answer that comes later. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(o: { name?: string; helper?: Record<string, Answer>; agentd?: Record<string, AgentdAnswer>; marks?: TurnMarks } = {}) {
  let clock = 1_800_000_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const requests: [string, Record<string, unknown>][] = [];
  const posts: [string, unknown][] = [];
  /** The headers of each post, in `posts`' order. */
  const headers: Record<string, string>[] = [];
  const stops: (number | undefined)[] = [];
  const hints: (VoiceHint | null)[] = [];
  const logs: string[] = [];
  const helper: Record<string, Answer> = {
    'ptt.register': ok({ registered: true }), 'ptt.unregister': ok({ unregistered: true }),
    'permissions.status': ok({ microphone: 'granted' }),
    'mic.start': (p) => ok({ session: p.session, locale: 'zh-CN', sample_rate: 48000 }),
    'mic.stop': (p) => ok({ session: p.session, text: '  明天 下午\n三点 开会 ', duration_ms: 900 }),
    ...o.helper,
  };
  const agentd: Record<string, AgentdAnswer> = {
    'POST /turn/cancel': { status: 202, body: { generation: 7 } },
    'POST /say': { status: 202, body: { line_id: 'l1', trace_id: 't1', generation: 8 } },
    ...o.agentd,
  };
  const ptt = new PushToTalk(o.name ?? 'control+option+space', {
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    agentd: async (method, path, json, sent) => {
      posts.push([`${method} ${path}`, json]);
      headers.push(sent);
      const a = agentd[`${method} ${path}`];
      if (a === undefined || a === 'down') throw new Error('connect ECONNREFUSED');
      const r = typeof a === 'function' ? await a() : a;
      return { status: r.status, body: JSON.stringify(r.body) };
    },
    stopSpeech: (g) => stops.push(g),
    onHint: (h) => hints.push(h),
    locale: () => 'zh-CN',
    now: () => clock,
    after: (ms, fn) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    log: (line) => logs.push(line),
    ...(o.marks && { marks: o.marks }),
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const s = {
    ptt, requests, posts, headers, stops, hints, logs, settle,
    ops: () => requests.map(([op]) => op),
    /** The page's `voice.onPushToTalk` values so far. */
    states: () => hints.map(pushToTalkState),
    last: () => pushToTalkState(hints.at(-1) ?? null),
    async advance(ms: number) {
      clock += ms;
      for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); }
      await settle();
    },
    async up() {
      ptt.helper(true);
      ptt.agentd(true);
      await settle();
    },
    async event(name: string, data: Record<string, unknown> = {}) {
      ptt.event(name, data);
      await settle();
    },
    /** Down, `ms` held, up. */
    async hold(ms: number) {
      await s.event('ptt.down');
      await s.advance(ms);
      await s.event('ptt.up');
    },
  };
  return s;
}

test('normalizeTranscript collapses whitespace, drops it between Chinese characters and cuts to 2000 code points', () => {
  assert.equal(normalizeTranscript('  明天 下午\n三点 开会 '), '明天下午三点开会');
  assert.equal(normalizeTranscript('open  the\tfile'), 'open the file');
  assert.equal(normalizeTranscript('好的 OK 走'), '好的 OK 走');
  assert.equal(normalizeTranscript('你好， 世界'), '你好，世界');
  assert.equal(normalizeTranscript(' \n '), '');
  assert.equal([...normalizeTranscript('𠀀'.repeat(2001))].length, 2000);
});

test('speechLocale: auto takes the first Chinese or English preferred language, else zh-CN; another setting is kept', () => {
  assert.equal(speechLocale('auto', ['ja-JP', 'en-GB', 'zh-Hans-CN']), 'en-US');
  assert.equal(speechLocale('auto', ['zh_TW']), 'zh-CN');
  assert.equal(speechLocale('auto', ['fr-FR']), 'zh-CN');
  assert.equal(speechLocale('en-US', ['zh-CN']), 'en-US');
});

test('a refused /say shows the short recovery for a role runtime, the code\'s sentence, or 没发出去', () => {
  assert.equal(rejectedHint('native_login_required', 'codex'), '角色内核未登录：终端运行 codex login');
  assert.equal(rejectedHint('local_runtime_missing', null), '没找到 Codex CLI 或 ACP agent');
  assert.equal(rejectedHint('switching', null), '她正在换角色，没发出去');
  assert.equal(rejectedHint('whatever', null), HINT.notSent);
});

test('the hint as protocol.ts PushToTalkState (pushToTalkState)', () => {
  assert.deepEqual(pushToTalkState(null), { phase: 'idle' });
  assert.deepEqual(pushToTalkState({ kind: 'listening', levels: [0.2], elapsed: 1, text: '明天下午' }), { phase: 'listening', partial: '明天下午' });
  assert.deepEqual(pushToTalkState({ kind: 'sent', text: '明天下午', elapsed: 2 }), { phase: 'sent', partial: '明天下午' });
  assert.deepEqual(pushToTalkState({ kind: 'discarded', reason: HINT.tooShort, elapsed: 0.1 }), { phase: 'error', error: '按住不到 0.3 秒' });
  assert.deepEqual(pushToTalkState({ kind: 'micDenied' }), { phase: 'error', error: 'mic_denied' });
});

test('the hot key registers once agentd and the helper run, again after each helper restart, and goes when agentd stops', async () => {
  const s = setup();
  s.ptt.helper(true);
  await s.settle();
  assert.deepEqual(s.ops(), [], 'not before agentd runs');
  s.ptt.agentd(true);
  await s.settle();
  assert.deepEqual(s.requests[0], ['ptt.register', { combo: 'control+option+space' }]);
  assert.equal(s.ptt.voice, 'on');
  s.ptt.helper(false);
  s.ptt.helper(true);
  await s.settle();
  assert.deepEqual(s.ops().filter((op) => op.startsWith('ptt.')), ['ptt.register', 'ptt.register']);
  s.ptt.agentd(false);
  await s.settle();
  assert.deepEqual(s.ops().filter((op) => op.startsWith('ptt.')), ['ptt.register', 'ptt.register', 'ptt.unregister']);
});

test('a hot key the helper refuses is the failed one and is logged', async () => {
  const s = setup({ helper: { 'ptt.register': err('hotkey_taken') } });
  await s.up();
  assert.equal(s.ptt.failedHotkey, 'control+option+space');
  assert.ok(s.logs.includes('VOICE hotkey_failed control+option+space code=hotkey_taken'), s.logs.join('\n'));
});

test('a launch name that is no hot key registers nothing and voice is off', async () => {
  const s = setup({ name: 'hyper+k' });
  await s.up();
  assert.deepEqual(s.ops(), []);
  assert.equal(s.ptt.voice, 'off');
  assert.ok(s.logs.includes('VOICE bad_hotkey hyper+k'));
});

test('a saved name replaces the key; an empty one turns push-to-talk off; one that is no hot key keeps the current key', async () => {
  const s = setup();
  const keys = () => s.requests.filter(([op]) => op.startsWith('ptt.'));
  await s.up();
  s.ptt.hotkeySaved('right_option');
  await s.settle();
  assert.deepEqual(keys().slice(1), [['ptt.unregister', {}], ['ptt.register', { combo: 'right_option' }]]);
  s.ptt.hotkeySaved('hyper+k');
  await s.settle();
  assert.equal(keys().length, 3);
  assert.ok(s.logs.includes('VOICE bad_hotkey hyper+k'));
  s.ptt.hotkeySaved('');
  await s.settle();
  assert.deepEqual(keys().at(-1), ['ptt.unregister', {}]);
  assert.equal(s.ptt.voice, 'off');
  assert.ok(s.logs.includes('VOICE hotkey cleared'));
  s.ptt.hotkeySaved('control+option+v');
  await s.settle();
  assert.deepEqual(keys().at(-1), ['ptt.register', { combo: 'control+option+v' }]);
});

test('a hold barges in, records and sends the transcript to POST /say as voice with its timing; the hint lingers 1.5 s', async () => {
  const s = setup();
  await s.up();
  await s.event('ptt.down');
  assert.deepEqual(s.stops, [undefined, 7], 'stop_speech at once, then with the new turn generation');
  assert.deepEqual(s.posts[0], ['POST /turn/cancel', { reason: 'barge_in' }]);
  const start = s.requests.find(([op]) => op === 'mic.start')!;
  assert.deepEqual(start[1], { session: start[1].session, locale: 'zh-CN', level_events: true });
  assert.equal(typeof start[1].session, 'string');
  assert.deepEqual(s.last(), { phase: 'listening', partial: '' });
  await s.event('mic.level', { session: start[1].session, rms: 0.1 });
  await s.event('speech.partial', { session: start[1].session, text: '明天下午' });
  await s.event('speech.partial', { session: 'other', text: '不是这次的' });
  assert.deepEqual(s.last(), { phase: 'listening', partial: '明天下午' });
  const hint = s.hints.at(-1) as Extract<VoiceHint, { kind: 'listening' }>;
  assert.equal(hint.levels.length, 1);
  assert.ok(Math.abs(hint.levels[0]! - 0.6) < 1e-9, 'log scale over the 50 dB above −50 dBFS');
  await s.advance(900);
  await s.event('ptt.up');
  assert.deepEqual(s.requests.find(([op]) => op === 'mic.stop')![1], { session: start[1].session });
  const t = 1_800_000_000_000;
  assert.deepEqual(s.posts[1], ['POST /say', { text: '明天下午三点开会', source: 'voice',
    voice_timing: { pressed_ms: t, released_ms: t + 900, final_ms: t + 900 } }]);
  assert.deepEqual(s.last(), { phase: 'sent', partial: '明天下午三点开会' });
  await s.advance(1499);
  assert.equal(s.last()?.phase, 'sent');
  await s.advance(1);
  assert.deepEqual(s.last(), { phase: 'idle' });
});

test('a barge-in agentd does not take stops the speech once and logs the status', async () => {
  for (const [answer, status] of [[{ status: 409, body: { error: 'x' } }, 409], ['down', 0]] as const) {
    const s = setup({ agentd: { 'POST /turn/cancel': answer } });
    await s.up();
    await s.event('ptt.down');
    assert.deepEqual(s.stops, [undefined]);
    assert.ok(s.logs.includes(`VOICE barge_in status=${status}`), s.logs.join('\n'));
  }
});

test('right Option alone waits out the 0.15 s window; a release inside it barges in and shows 按住不到 0.3 秒', async () => {
  const s = setup({ name: 'right_option' });
  await s.up();
  await s.hold(100);
  assert.deepEqual(s.ops(), ['ptt.register', 'permissions.status'], 'only the grant read after registering');
  assert.deepEqual(s.stops, [undefined, 7]);
  assert.deepEqual(s.last(), { phase: 'error', error: HINT.tooShort });
  await s.advance(1500);
  assert.deepEqual(s.last(), { phase: 'idle' });
  await s.event('ptt.down');
  await s.advance(149);
  assert.ok(!s.ops().includes('mic.start'));
  await s.advance(1);
  assert.ok(s.ops().includes('mic.start'));
});

test('a hold under 0.3 s records but sends nothing and shows 按住不到 0.3 秒', async () => {
  const s = setup();
  await s.up();
  await s.hold(200);
  assert.ok(s.ops().includes('mic.stop'));
  assert.ok(!s.posts.some(([p]) => p === 'POST /say'));
  assert.deepEqual(s.last(), { phase: 'error', error: HINT.tooShort });
  assert.ok(s.logs.includes('VOICE discarded'));
});

test('nothing recognized sends nothing and shows 没听清', async () => {
  const s = setup({ helper: { 'mic.stop': (p) => ok({ session: p.session, text: ' ', duration_ms: 800 }) } });
  await s.up();
  await s.hold(800);
  assert.ok(!s.posts.some(([p]) => p === 'POST /say'));
  assert.deepEqual(s.last(), { phase: 'error', error: HINT.nothingHeard });
});

test('a release while the microphone starts stops it once it runs; a press again before that keeps it going', async () => {
  let started = later<HelperAnswer>();
  const s = setup({ helper: { 'mic.start': () => started.promise } });
  await s.up();
  await s.hold(500);
  assert.ok(!s.ops().includes('mic.stop'));
  started.resolve(ok({ session: 's', locale: 'zh-CN', sample_rate: 48000 }));
  await s.settle();
  assert.ok(s.ops().includes('mic.stop'), 'stopped as soon as it started');
  assert.equal(s.posts.at(-1)![0], 'POST /say');

  started = later<HelperAnswer>();
  const again = setup({ helper: { 'mic.start': () => started.promise } });
  await again.up();
  await again.hold(300);
  await again.event('ptt.down');
  started.resolve(ok({ session: 's', locale: 'zh-CN', sample_rate: 48000 }));
  await again.settle();
  assert.ok(!again.ops().includes('mic.stop'), 'held again');
  assert.equal(again.last()?.phase, 'listening');
});

test('a press while recording or stopping is ignored', async () => {
  const s = setup();
  await s.up();
  await s.event('ptt.down');
  await s.event('ptt.down');
  assert.equal(s.ops().filter((op) => op === 'mic.start').length, 1);
  assert.equal(s.stops.length, 2);
});

test('a microphone another app holds, or one that does not start, drops the hint and sends nothing', async () => {
  for (const code of ['mic_busy', 'permission_denied', 'locale_unsupported', 'asr_unavailable']) {
    const s = setup({ helper: { 'mic.start': err(code) } });
    await s.up();
    await s.event('ptt.down');
    assert.deepEqual(s.last(), { phase: 'idle' }, code);
    assert.ok(s.logs.includes(`VOICE failed mic.start ${code}`), s.logs.join('\n'));
    await s.advance(500);
    await s.event('ptt.up');
    assert.ok(!s.ops().includes('mic.stop') && !s.posts.some(([p]) => p === 'POST /say'), code);
  }
});

test('a denied microphone shows mic_denied until the release, then 1.5 s more; voice is denied', async () => {
  const s = setup({ helper: { 'permissions.status': ok({ microphone: 'denied' }) } });
  await s.up();
  assert.equal(s.ptt.voice, 'denied', 'read once the key is registered');
  await s.event('ptt.down');
  assert.ok(!s.ops().includes('mic.start'));
  assert.deepEqual(s.stops, [undefined, 7], 'still a barge-in');
  assert.deepEqual(s.last(), { phase: 'error', error: 'mic_denied' });
  assert.equal(s.ptt.voice, 'denied');
  assert.ok(s.logs.includes('VOICE mic_denied'));
  await s.advance(3000);
  assert.deepEqual(s.last(), { phase: 'error', error: 'mic_denied' });
  await s.event('ptt.up');
  await s.advance(1500);
  assert.deepEqual(s.last(), { phase: 'idle' });
});

test('an undecided microphone is asked for; granted tells to hold again, refused shows mic_denied; both go after 1.5 s', async () => {
  for (const [state, shown] of [['granted', { phase: 'error', error: HINT.micAllowed }], ['denied', { phase: 'error', error: 'mic_denied' }]] as const) {
    const s = setup({ helper: { 'permissions.status': ok({ microphone: 'notDetermined' }), 'permissions.request': ok({ state }) } });
    await s.up();
    await s.event('ptt.down');
    assert.deepEqual(s.requests.find(([op]) => op === 'permissions.request')![1], { kind: 'microphone' });
    assert.ok(!s.ops().includes('mic.start'), 'the press that asked records nothing');
    assert.deepEqual(s.last(), shown);
    await s.event('ptt.up');
    await s.advance(1500);
    assert.deepEqual(s.last(), { phase: 'idle' }, state);
  }
});

test('without the helper a press barges in, logs and drops the hint', async () => {
  const s = setup({ helper: { 'permissions.status': err('helper_exited') } });
  await s.up();
  await s.event('ptt.down');
  assert.deepEqual(s.stops, [undefined, 7]);
  assert.ok(s.logs.includes('VOICE failed permissions.status helper_exited'));
  assert.deepEqual(s.last(), { phase: 'idle' });
});

test('a helper that exits while recording ends the hold as interrupted: nothing heard, nothing sent', async () => {
  const s = setup({ helper: { 'mic.stop': err('helper_exited') } });
  await s.up();
  await s.event('ptt.down');
  await s.advance(800);
  s.ptt.helper(false);
  await s.settle();
  assert.ok(s.ops().includes('mic.stop'));
  assert.ok(!s.posts.some(([p]) => p === 'POST /say'));
  assert.deepEqual(s.last(), { phase: 'error', error: HINT.nothingHeard });
});

test('held (the sampler\'s user_speaking) is true from ptt.down to ptt.up and false once the helper goes', async () => {
  const s = setup();
  await s.up();
  assert.equal(s.ptt.held, false);
  await s.event('ptt.down');
  await s.advance(800);
  assert.equal(s.ptt.held, true);
  await s.event('ptt.up');
  assert.equal(s.ptt.held, false);
  await s.event('ptt.down');
  assert.equal(s.ptt.held, true);
  s.ptt.helper(false);
  assert.equal(s.ptt.held, false);
});

test('agentd unreachable shows 没发出去; a refusal shows its sentence', async () => {
  const down = setup({ agentd: { 'POST /say': 'down' } });
  await down.up();
  await down.hold(800);
  assert.deepEqual(down.last(), { phase: 'error', error: HINT.notSent });
  const refused = setup({ agentd: { 'POST /say': { status: 409, body: { error: 'switching' } } } });
  await refused.up();
  await refused.hold(800);
  assert.deepEqual(refused.last(), { phase: 'error', error: '她正在换角色，没发出去' });
  const command = setup({ agentd: { 'POST /say': { status: 200, body: { command: 'stop' } } } });
  await command.up();
  await command.hold(800);
  assert.equal(command.last()?.phase, 'sent');
});

test('a new press while /say is on its way owns the hint', async () => {
  const said = later<{ status: number; body: unknown }>();
  const s = setup({ agentd: { 'POST /say': () => said.promise } });
  await s.up();
  await s.hold(800);
  await s.event('ptt.down');
  said.resolve({ status: 202, body: { line_id: 'l1' } });
  await s.settle();
  assert.deepEqual(s.last(), { phase: 'listening', partial: '' });
});

test('/say carries an Idempotency-Key, and a dropped connection is sent once more with the same key', async () => {
  let tries = 0;
  const s = setup({ agentd: { 'POST /say': () => {
    tries += 1;
    if (tries === 1) throw new Error('socket hang up');
    return { status: 202, body: { line_id: 'l1', trace_id: 't1', generation: 8 } };
  } } });
  await s.up();
  await s.hold(800);
  const says = s.posts.flatMap(([p], i) => (p === 'POST /say' ? [s.headers[i]!] : []));
  assert.equal(says.length, 2);
  assert.match(says[0]!['Idempotency-Key']!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(says[1]!['Idempotency-Key'], says[0]!['Idempotency-Key']);
  assert.equal(s.last()?.phase, 'sent');
  await s.hold(800);
  const next = s.posts.flatMap(([p], i) => (p === 'POST /say' ? [s.headers[i]!['Idempotency-Key']] : []));
  assert.equal(next.length, 3);
  assert.notEqual(next[2], next[0], 'a new say, a new key');
});

test('a line /say took marks ui.submitted and ui.ack', async () => {
  const marks: string[] = [];
  const s = setup({ marks: new TurnMarks((kind, trace, turn, generation) => marks.push(`${kind} ${trace} ${turn} ${generation}`)) });
  await s.up();
  await s.hold(800);
  assert.deepEqual(marks, ['ui.submitted t1 l1 8', 'ui.ack t1 l1 8']);
});

test('an undecided speech grant is asked for on a press with the microphone allowed; that press records nothing (PushToTalkPress.steps)', async () => {
  let speech = 'notDetermined';
  const s = setup({ helper: { 'permissions.status': () => ok({ microphone: 'granted', speech }),
    'permissions.request': () => { speech = 'granted'; return ok({ state: 'granted' }); } } });
  await s.up();
  await s.event('ptt.down');
  assert.deepEqual(s.stops, [undefined, 7], 'still a barge-in');
  assert.deepEqual(s.requests.find(([op]) => op === 'permissions.request')![1], { kind: 'microphone' },
    'the helper asks for speech with the microphone (CONTRACT §7.9)');
  assert.ok(!s.ops().includes('mic.start'));
  assert.deepEqual(s.last(), { phase: 'error', error: HINT.micAllowed });
  await s.event('ptt.up');
  await s.advance(1500);
  assert.deepEqual(s.last(), { phase: 'idle' });
  await s.event('ptt.down');
  assert.ok(s.ops().includes('mic.start'), 'the next press records');
});

test('a speech grant the helper cannot ask for, or does not report, records at once', async () => {
  const s = setup({ helper: { 'permissions.status': ok({ microphone: 'granted', speech: 'notApplicable' }) } });
  await s.up();
  await s.event('ptt.down');
  assert.ok(s.ops().includes('mic.start') && !s.ops().includes('permissions.request'));
});

test('speech.download while mic.start runs shows the download in MB, logged once; then the recording', async () => {
  const started = later<HelperAnswer>();
  const s = setup({ helper: { 'mic.start': () => started.promise } });
  await s.up();
  await s.event('ptt.down');
  const session = s.requests.find(([op]) => op === 'mic.start')![1].session;
  await s.event('speech.download', { session, fraction: 0.25, completed: 52_000_000, total: 208_000_000 });
  await s.event('speech.download', { session: 'other', fraction: 0.9, completed: 1, total: 2 });
  await s.event('speech.download', { session, fraction: 0.5, completed: 104_000_000, total: 208_000_000 });
  assert.deepEqual(s.hints.at(-1), { kind: 'downloading', fraction: 0.5, receivedMB: 104, totalMB: 208 });
  assert.equal(pushToTalkState(s.hints.at(-1)!), null, 'the page gets no state for a download (WebBridge.pushToTalkState)');
  assert.equal(s.logs.filter((l) => l === 'VOICE asset_download').length, 1);
  started.resolve(ok({ session, locale: 'zh-CN', sample_rate: 48000 }));
  await s.settle();
  assert.deepEqual(s.last(), { phase: 'listening', partial: '' });
});

test('a release during the download drops the hint once it is done and sends nothing', async () => {
  const started = later<HelperAnswer>();
  const s = setup({ helper: { 'mic.start': () => started.promise } });
  await s.up();
  await s.event('ptt.down');
  const session = s.requests.find(([op]) => op === 'mic.start')![1].session;
  await s.event('speech.download', { session, fraction: 0.5, completed: 1, total: 2 });
  await s.advance(800);
  await s.event('ptt.up');
  started.resolve(ok({ session, locale: 'zh-CN', sample_rate: 48000 }));
  await s.settle();
  assert.deepEqual(s.requests.find(([op]) => op === 'mic.stop')![1], { session, discard: true });
  assert.ok(!s.posts.some(([p]) => p === 'POST /say'));
  assert.deepEqual(s.last(), { phase: 'idle' });
});

test('a key typed in right Option\'s window is Option typing: nothing starts and its release shows nothing (PushToTalkPress.decide)', async () => {
  const s = setup({ name: 'right_option' });
  await s.up();
  await s.event('ptt.down');
  await s.advance(100);
  await s.event('ptt.typed');
  await s.advance(200);
  await s.event('ptt.up');
  assert.deepEqual(s.ops(), ['ptt.register', 'permissions.status'], 'nothing after registering');
  assert.deepEqual(s.stops, [], 'no barge-in');
  assert.deepEqual(s.hints, []);
  await s.event('ptt.down');
  await s.advance(150);
  assert.ok(s.ops().includes('mic.start'), 'the next press is push-to-talk again');
});

test('a key typed while right Option records drops the recording and its hint at once', async () => {
  const s = setup({ name: 'right_option' });
  await s.up();
  await s.event('ptt.down');
  await s.advance(150);
  await s.event('ptt.typed');
  await s.advance(800);
  await s.event('ptt.up');
  assert.ok(s.ops().includes('mic.stop'));
  assert.ok(!s.posts.some(([p]) => p === 'POST /say'));
  assert.deepEqual(s.last(), { phase: 'idle' });
  assert.ok(s.logs.includes('VOICE discarded'));
  await s.event('ptt.down');
  await s.advance(950);
  await s.event('ptt.up');
  assert.ok(s.posts.some(([p]) => p === 'POST /say'), 'the next hold without typing is sent');
});

test('ptt.typed counts for right Option only: a hot key with a key of its own is sent', async () => {
  const s = setup();
  await s.up();
  await s.event('ptt.down');
  await s.event('ptt.typed');
  await s.advance(800);
  await s.event('ptt.up');
  assert.ok(s.posts.some(([p]) => p === 'POST /say'));
});
