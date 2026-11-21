// The C3 messages HostLink handles beyond the handshake, actions and looks: each
// against the contract's examples, valid and invalid, over a fake renderer's connection.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type C3Message, decodeLine } from '../src/common/c3.ts';
import { HostLink, type LinkOptions } from '../src/main/renderer/link.ts';
import { FakeAvatar } from './fake-avatar.ts';

const EXAMPLES = resolve(import.meta.dirname, '../../../protocol/C3-host-ipc/examples');
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.01);
  }
  return ok();
}
const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;

/** The example lines of these types in the files of one direction, each with its file. */
function examples(prefix: 'avatar-to-companion' | 'companion-to-avatar', types: string[]): { file: string; m: C3Message }[] {
  return readdirSync(EXAMPLES).filter((f) => f.startsWith(prefix) && f.endsWith('.ndjson')).sort().flatMap((file) =>
    readFileSync(join(EXAMPLES, file), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => ({ file, m: decodeLine(l)! }))
      .filter(({ m }) => types.includes(m.type)));
}
/** Invalid example files of one direction whose last line is one of these types. */
function invalid(prefix: 'a2c' | 'c2a', types: string[]): { file: string; lines: C3Message[] }[] {
  const dir = join(EXAMPLES, 'invalid');
  // Some files of other types are not JSON at all (`NaN`); decodeLine drops those lines.
  return readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`)).sort().map((file) => ({ file,
    lines: readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.trim() !== '').map(decodeLine) }))
    .filter((x): x is { file: string; lines: C3Message[] } => x.lines.length > 0 && x.lines.every((l) => l !== null)
      && types.includes(x.lines.at(-1)!.type));
}

const ALL_AVATAR = ['ack', 'actions', 'touch', 'presentation', 'drop', 'surfaces', 'opacity', 'layering', 'poses', 'capture', 'camera_gesture',
  'motion_overrides', 'play_chain', 'pass_through', 'render_live', 'ambient', 'camera_free', 'camera_track', 'camera_bust', 'filters', 'photo', 'playback'];
const OFFERS = ['pass_through', 'render_live', 'ambient', 'camera_free', 'camera_track', 'filters', 'capture', 'motion_overrides', 'play_chain',
  'photo', 'camera_bust'] as const;
const BASE = ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings'];

async function withLink(extra: Partial<LinkOptions>, body: (link: HostLink, lines: string[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'l-')), lines: string[] = [];
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => lines.push(l), ...extra });
  await link.start();
  try {
    await body(link, lines);
  } finally {
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function attach(link: HostLink, hello: Record<string, unknown>): Promise<FakeAvatar> {
  const a = new FakeAvatar(link.path);
  a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: [], ...hello });
  assert.ok(await until(2, () => a.got.some((m) => m.type === 'fps_tier') && link.hello?.pid === hello.pid), `${a.got.map((m) => m.type)}`);
  return a;
}

test('hello: without the new callbacks it is the same line as before; with them it lists their capabilities in a fixed order', { skip: UNIX_LINK }, async () => {
  await withLink({}, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: ['touch', 'surfaces', 'presentation'] });
    assert.equal(a.raw[0], '{"v":1,"type":"hello","role":"companion","pid":4242,"protocol":1,'
      + '"capabilities":["capsules_global","watchdog","actions","keep_clear","action_loop","layers","mod_settings"],"build":{"version":"t"}}');
    assert.ok(!a.got.some((m) => m.type === 'touch_settings'));
    a.socket.destroy();
  });
  const none = () => {};
  await withLink({ onClick: none, onPresentationState: none, onSpeechCancelled: none, onPlayback: none, onSurfaceTrack: none, onDrop: none,
    onMotionStroke: none, onPoseState: none, onCameraGesture: none, offers: OFFERS,
    touchSettings: () => ({ regions: true, pat: true, pinch: false, greet: true }) }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: ['touch'] });
    assert.deepEqual(a.got[0]!.capabilities, [...BASE, 'presentation', 'drop', 'pass_through', 'render_live', 'ambient', 'touch', 'poses',
      'camera_free', 'camera_track', 'camera_gesture', 'filters', 'capture', 'motion_overrides', 'play_chain', 'photo', 'camera_bust',
      'surfaces', 'opacity', 'layering']);
    // touch_settings comes right after the fps tier.
    assert.ok(await until(1, () => a.got.length >= 3));
    assert.deepEqual(a.got.slice(1).map((m) => m.type), ['fps_tier', 'touch_settings']);
    assert.deepEqual(a.got[2], { v: 1, type: 'touch_settings', regions: true, pat: true, pinch: false, greet: true });
    a.socket.destroy();
  });
});

test('hello: another peer\'s hello while a renderer is connected is refused and closed; the next renderer is taken once that one is gone', { skip: UNIX_LINK }, async () => {
  const clicks: unknown[] = [];
  await withLink({ onClick: (c) => clicks.push(c) }, async (link, log) => {
    const first = await attach(link, { pid: 99 });
    const peer = new FakeAvatar(link.path);
    let peerClosed = false;
    peer.socket.on('close', () => { peerClosed = true; });
    peer.send({ type: 'hello', role: 'avatar', pid: 100, protocol: 1, character: 'aster', capabilities: [] });
    peer.send({ type: 'click', button: 'left', count: 2, x: 1, y: 1 });
    await until(2, () => peerClosed || link.hello?.pid !== 99);
    assert.equal(link.hello?.pid, 99, 'the connected renderer keeps the link');
    assert.ok(await until(2, () => peerClosed), log.join('\n'));
    assert.deepEqual(peer.got, [], 'the refused peer gets no hello');
    first.send({ type: 'click', button: 'left', count: 2, x: 1, y: 1 });
    assert.ok(await until(1, () => clicks.length > 0));
    assert.deepEqual(clicks, [{ kind: 'double' }], 'only the first renderer\'s click reaches the shell');
    first.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    const next = await attach(link, { pid: 101 });
    assert.equal(link.hello?.pid, 101);
    next.socket.destroy();
  });
});

const INBOUND = ['click', 'speech_cancelled', 'playback', 'track_surface', 'untrack_surface', 'attach', 'drop', 'motion.stroke', 'pose_state',
  'camera_gesture'];

test('inbound: every valid example of the callback messages reaches its callback with its fields; every invalid one is dropped', { skip: UNIX_LINK }, async () => {
  const got: unknown[][] = [];
  const record = (type: string) => (...args: unknown[]) => got.push([type, ...args]);
  await withLink({ onClick: record('click'), onSpeechCancelled: record('speech_cancelled'), onPlayback: record('playback'),
    onSurfaceTrack: record('surface'), onDrop: record('drop'), onMotionStroke: record('motion.stroke'), onPoseState: record('pose_state'),
    onCameraGesture: record('camera_gesture'), touchSettings: () => ({ regions: true, pat: true, pinch: false, greet: true }), offers: OFFERS },
  async (link, log) => {
    const frame = { type: 'window_frame', frame: { x: 1000, y: 2000, w: 540, h: 780 }, scale: 2, window_number: 1 };
    const a = await attach(link, { pid: 99, capabilities: ALL_AVATAR });
    a.send(frame);
    const valid = examples('avatar-to-companion', INBOUND);
    assert.ok(valid.length >= 25, `${valid.length} examples`);
    for (const { file, m } of valid) {
      got.length = 0;
      a.send(m);
      assert.ok(await until(1, () => got.length === 1), `${file} ${JSON.stringify(m)}\n${log.slice(-3).join('\n')}`);
      const { v: _v, type: _t, ...body } = m;
      const at = { x: 1000 + (m.x as number), y: 2000 + (m.y as number) };
      const expected: Record<string, unknown[]> = {
        click: ['click', m.button === 'right' ? { kind: 'right', at } : m.count === 2 ? { kind: 'double' } : { kind: 'left', at, region: m.region ?? null }],
        speech_cancelled: ['speech_cancelled', m.speech_id, m.reason === 'client_cancel' ? 'client_cancel' : 'error'],
        playback: ['playback', body],
        track_surface: ['surface', { kind: 'track', trackId: m.track_id, windowId: m.window_id, generation: m.generation ?? null }],
        untrack_surface: ['surface', { kind: 'untrack', trackId: m.track_id }],
        attach: ['surface', { kind: 'attach', trackId: m.track_id }],
        drop: ['drop', { items: m.items, x: m.x, y: m.y, truncated: m.truncated ?? false }],
        'motion.stroke': ['motion.stroke', m.token, m.clip],
        pose_state: ['pose_state', { character: m.character, id: m.id, locked: m.locked }],
        camera_gesture: ['camera_gesture', { phase: m.phase, dx: m.dx, dy: m.dy, zoom: m.zoom }],
      };
      assert.deepEqual(got[0], expected[m.type], file);
    }
    // The two replies end the open request of their `req`, once its `ack` came (rules 50, 51).
    const replies = examples('avatar-to-companion', ['captured', 'motion_overrides']);
    assert.ok(replies.length >= 4, `${replies.length} replies`);
    for (const { file, m } of replies) {
      const open: Promise<unknown> = m.type === 'captured' ? link.capture()
        : link.setMotionOverrides(m.character as string, { chains: {}, pools: {}, blend_in: {} });
      const asked = m.type === 'captured' ? 'capture' : 'set_motion_overrides';
      const before = a.got.filter((g) => g.type === asked).length;
      assert.ok(await until(1, () => a.got.filter((g) => g.type === asked).length > before), file);
      const req = a.last(asked)!.req;
      a.send({ type: 'ack', req, ok: true });
      a.send({ ...m, req });
      const { v: _v, type: _t, ...body } = m;
      assert.deepEqual(await open, m.type === 'captured' ? { file: m.file, width: m.width, height: m.height } : { ...body, req, truncated: m.truncated ?? false }, file);
    }
    a.socket.destroy();

    const bad = invalid('a2c', [...INBOUND, 'captured', 'motion_overrides']);
    assert.ok(bad.length >= 24, `${bad.length} invalid files`);
    for (const { file, lines } of bad) {
      got.length = 0;
      const logged = log.length;
      const b = new FakeAvatar(link.path);
      if (lines[0]!.type !== 'hello') {
        b.send({ type: 'hello', role: 'avatar', pid: 98, protocol: 1, character: 'aster', capabilities: ALL_AVATAR });
        b.send(frame);
      }
      for (const line of lines) b.send(line);
      b.send({ type: 'motion.stroke', token: 'sentinel', clip: 'c' });
      assert.ok(await until(1, () => got.some((g) => g[1] === 'sentinel')), file);
      assert.deepEqual(got, [['motion.stroke', 'sentinel', 'c']], file);
      assert.ok(log.slice(logged).some((l) => l.startsWith(`rejected type=${lines.at(-1)!.type} `)), `${file}: ${log.slice(logged).join(' | ')}`);
      b.socket.destroy();
    }
  });
});

test('inbound: presentation_state for the shown character only; the open speeches end as connection_lost with the link', { skip: UNIX_LINK }, async () => {
  const states: unknown[] = [], playbacks: Record<string, unknown>[] = [];
  await withLink({ onPresentationState: (s) => states.push(s), onPlayback: (p) => playbacks.push(p) }, async (link, log) => {
    const a = await attach(link, { pid: 99, capabilities: ['presentation', 'playback'] });
    const state = { req: 3, character: 'aster', phase: 'applied', frame: 120, expressions: ['smile'], expression: 'smile',
      weather_supported: true, face_effect_supported: false, coverage: { drops: 0.2, wetness: 0.1, snow: 0 } };
    a.send({ type: 'presentation_state', ...state, character: 'cedar' });
    a.send({ type: 'presentation_state', ...state, phase: 'applied', frame: undefined });
    a.send({ type: 'presentation_state', ...state });
    assert.ok(await until(1, () => states.length === 1));
    assert.deepEqual(states, [state]);
    assert.deepEqual(log.filter((l) => l.startsWith('rejected type=presentation_state')), ['rejected type=presentation_state why=character',
      'rejected type=presentation_state why=frame']);
    a.send({ type: 'playback', speech_id: 's1', clause_id: 'c0', state: 'started', sample: 0, rate: 48000 });
    a.send({ type: 'playback', speech_id: 's1', clause_id: 'c1', state: 'buffering', sample: 2400, rate: 48000 });
    a.send({ type: 'playback', speech_id: 's2', clause_id: null, state: 'started', sample: 0, rate: 24000 });
    a.send({ type: 'playback', speech_id: 's2', clause_id: null, state: 'ended', sample: 900, rate: 24000 });
    assert.ok(await until(1, () => playbacks.length === 4));
    a.socket.destroy();
    assert.ok(await until(2, () => playbacks.length === 5));
    assert.deepEqual(playbacks[4], { speech_id: 's1', clause_id: 'c1', state: 'interrupted', reason: 'connection_lost', sample: 2400, rate: 48000 });
  });
});

/** Calls the link's sender for an example line; true when it accepted it. */
function sendExample(link: HostLink, m: C3Message, touch: { value: Record<string, boolean> }): boolean | Promise<unknown> {
  const { v: _v, type: _t, req: _r, ...body } = m;
  switch (m.type) {
    case 'surfaces': return link.sendSurfaces(m.seq as number, m.windows as never);
    case 'surface': return link.sendSurface(body as never);
    case 'covered': return link.sendCovered(m.window_id === null ? null : body as never);
    case 'pass_through': return link.sendPassThrough(m.rects as never);
    case 'attention_side': return link.sendAttentionSide(m.source as string, m.kind as string, m.side as string);
    case 'present': return link.sendPresent(m.token as string, m.side as string, m.phase as string);
    case 'ambient_sample': return link.sendAmbientSample(m.source as string, m.colors as never);
    case 'touch_settings':
      touch.value = body as Record<string, boolean>;
      return link.touchSettingsChanged();
    case 'set_render': return link.sendSetRender(body);
    case 'set_pose': return link.sendSetPose(m.id as string | null, m.lock as boolean);
    case 'set_motion_overrides': return link.setMotionOverrides(m.character as string, { chains: m.chains, pools: m.pools, blend_in: m.blend_in } as never);
    case 'play_chain': return link.playChain(m.play_id as string, m.character as string, m.start as string, m.speed as number | undefined);
    case 'capture': return link.capture(m.background as string);
    default: throw new Error(m.type);
  }
}
const OUTBOUND = ['surfaces', 'surface', 'covered', 'pass_through', 'attention_side', 'present', 'ambient_sample', 'touch_settings', 'set_render',
  'set_pose', 'set_motion_overrides', 'play_chain', 'capture'];
const withoutReq = (m: C3Message | undefined) => {
  if (m === undefined) return undefined;
  const { req: _r, ...rest } = m;
  return rest;
};

test('outbound: every valid example of the thirteen messages goes out as written; no invalid one reaches the wire', { skip: UNIX_LINK }, async () => {
  const touch = { value: { regions: false, pat: false, pinch: false, greet: false } };
  await withLink({ offers: OFFERS, onSurfaceTrack: () => {}, onPoseState: () => {}, touchSettings: () => touch.value as never, timeScale: 0.001 },
    async (link, log) => {
      const a = await attach(link, { pid: 99, capabilities: ALL_AVATAR });
      const valid = examples('companion-to-avatar', OUTBOUND);
      assert.ok(valid.length >= 35, `${valid.length} examples`);
      let generation: number | null = null;
      for (const { file, m } of valid) {
        const before = a.got.length;
        await sleep(0.05);
        const sent = sendExample(link, m, touch);
        if (typeof sent === 'boolean') assert.ok(sent, `${file} ${JSON.stringify(m)} ${log.at(-1)}`);
        else sent.catch(() => {});
        assert.ok(await until(1, () => a.got.slice(before).some((g) => g.type === m.type)), `${file} ${m.type}`);
        const out = a.got.slice(before).find((g) => g.type === m.type)!;
        if (m.type === 'attention_side') {
          // HostLink.attentionGeneration counts from 0 per link, one per line sent.
          assert.equal(out.generation, generation === null ? 0 : generation + 1);
          generation = out.generation as number;
          assert.deepEqual({ ...out, generation: m.generation }, m, file);
        } else {
          assert.deepEqual(withoutReq(out), withoutReq(m), file);
          if (['set_pose', 'set_motion_overrides', 'play_chain', 'capture'].includes(m.type)) assert.ok(Number.isInteger(out.req), file);
        }
      }
      a.socket.destroy();

      const bad = invalid('c2a', OUTBOUND);
      assert.ok(bad.length >= 40, `${bad.length} invalid files`);
      for (const { file, lines } of bad) {
        const hello = lines[0]!.type === 'hello' ? lines[0]!.capabilities as string[] : ALL_AVATAR;
        const b = await attach(link, { pid: 200 + bad.indexOf(bad.find((x) => x.file === file)!), capabilities: hello });
        const m = lines.at(-1)!;
        const sent = sendExample(link, m, touch);
        if (typeof sent !== 'boolean') await sent.then(() => assert.fail(file), () => {});
        assert.ok(link.sendPresent('sentinel', 'left', 'open'));
        assert.ok(await until(1, () => b.last('present')?.token === 'sentinel'), file);
        // A command always goes out with a `req`, so a `-missing-req` example is compared with it.
        const wire = b.got.filter((g) => g.type === m.type).map((g) => (file.endsWith('-missing-req.ndjson') ? g : withoutReq(g)));
        assert.ok(!wire.some((g) => JSON.stringify(g) === JSON.stringify(withoutReq(m))), `${file} went out: ${JSON.stringify(wire)}`);
        b.socket.destroy();
      }
    });
});

test('requests with replies: ack results and their timeout, capture and set_motion_overrides, and a dropped link', { skip: UNIX_LINK }, async () => {
  await withLink({ offers: OFFERS, onPoseState: () => {}, timeScale: 0.25 }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: ALL_AVATAR });
    const results: unknown[] = [];
    assert.ok(link.sendSetRender({ outline: 'subtle' }, (r) => results.push(['render', r])));
    assert.ok(link.sendSetPose('pose_sit_chair', true, (r) => results.push(['pose', r])));
    assert.ok(link.playChain('pc-1', 'aster', 'start_clip', 2, (r) => results.push(['chain', r])));
    assert.ok(await until(1, () => a.last('play_chain') !== undefined));
    a.send({ type: 'ack', req: a.last('set_render')!.req, ok: true });
    a.send({ type: 'ack', req: a.last('set_pose')!.req, ok: false, error: 'busy' });
    // play_chain gets no ack: rule 18's 2 s.
    assert.ok(await until(1, () => results.length === 3));
    assert.deepEqual(results, [['render', { ok: true }], ['pose', { ok: false, reason: 'busy' }], ['chain', { ok: false, reason: 'timeout' }]]);

    const shot = link.capture();
    assert.ok(await until(1, () => a.last('capture') !== undefined));
    const req = a.last('capture')!.req;
    a.send({ type: 'captured', req, file: 'early.png', width: 1, height: 1 });
    a.send({ type: 'ack', req, ok: true });
    a.send({ type: 'captured', req, file: 'Endfield-aster-20261120-101010.png', width: 1080, height: 1920 });
    assert.deepEqual(await shot, { file: 'Endfield-aster-20261120-101010.png', width: 1080, height: 1920 });
    const busy = link.capture();
    assert.ok(await until(1, () => a.last('capture')!.req !== req));
    a.send({ type: 'ack', req: a.last('capture')!.req, ok: false, error: 'busy' });
    await assert.rejects(busy, { code: 'busy' });
    // HostLink.captureTimeout: 10 s, scaled here.
    await assert.rejects(link.capture(), { code: 'timeout' });

    const overrides = { chains: { a_start: false }, pools: {}, blend_in: { a_start: 0.2 } };
    const saved = link.setMotionOverrides('aster', overrides);
    assert.ok(await until(1, () => a.last('set_motion_overrides') !== undefined));
    const mreq = a.last('set_motion_overrides')!.req;
    a.send({ type: 'ack', req: mreq, ok: true });
    a.send({ type: 'motion_overrides', req: mreq, character: 'aster', applied: { chains: 1, pools: 0, blend_in: 0 },
      adjusted: [{ kind: 'blend_in', key: 'a_start', reason: 'unknown_clip' }] });
    assert.deepEqual(await saved, { req: mreq, character: 'aster', applied: { chains: 1, pools: 0, blend_in: 0 },
      adjusted: [{ kind: 'blend_in', key: 'a_start', reason: 'unknown_clip' }], truncated: false });
    await assert.rejects(link.setMotionOverrides('aster', overrides), { code: 'failed', message: '角色没有回应' });
    const refused = link.setMotionOverrides('aster', overrides);
    assert.ok(await until(1, () => a.got.filter((m) => m.type === 'set_motion_overrides').length === 3));
    a.send({ type: 'ack', req: a.last('set_motion_overrides')!.req, ok: false, error: 'busy' });
    await assert.rejects(refused, { message: '角色正在切换或动作还没加载好，过一会儿再试' });

    // Rules 18, 50, 51: everything open fails when the link drops.
    const lost: unknown[] = [];
    link.sendSetRender({ facing: 'front' }, (r) => lost.push(r));
    const shot2 = link.capture(), saved2 = link.setMotionOverrides('aster', overrides);
    assert.ok(await until(1, () => a.got.filter((m) => m.type === 'set_motion_overrides').length === 4));
    a.socket.destroy();
    await assert.rejects(shot2, { code: 'failed', message: 'disconnected' });
    await assert.rejects(saved2, { message: '和角色的连接断了' });
    assert.deepEqual(lost, [{ ok: false, reason: 'disconnected' }]);
    assert.equal(link.sendSetRender({ facing: 'front' }), false);
    await assert.rejects(link.capture(), { code: 'unsupported' });
  });
});

test('outbound gates: both sides list the capability; attention_side waits 45 s and not while hidden', { skip: UNIX_LINK }, async () => {
  await withLink({}, async (link) => {
    await attach(link, { pid: 99, capabilities: ALL_AVATAR });
    // This link lists none of them.
    assert.equal(link.sendPassThrough([]), false);
    assert.equal(link.sendSetRender({ outline: 'subtle' }), false);
    assert.equal(link.sendCovered(null), false);
    assert.equal(link.sendSurfaces(0, []), false);
    assert.equal(link.sendSetPose(null, false), false);
    assert.equal(link.playChain('p', 'aster', 's'), false);
    await assert.rejects(link.capture(), { code: 'unsupported' });
    assert.ok(link.sendPresent('t', 'left', 'open'));
    assert.ok(link.sendAttentionSide('panel', 'comm', 'left'));
    assert.equal(link.sendAttentionSide('focus', 'window', 'right'), false, 'within 45 s');
  });
  await withLink({ offers: OFFERS }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: ['ack'] });
    assert.equal(link.sendPassThrough([]), false, 'the avatar does not list it');
    link.setVisible(false);
    assert.equal(link.sendAttentionSide('panel', 'comm', 'left'), false, 'hidden');
    link.setVisible(true);
    assert.equal(link.sendAttentionSide('panel', 'comm', 'up'), false);
    assert.ok(link.sendAttentionSide('panel', 'comm', 'left'));
    assert.ok(await until(1, () => a.last('attention_side') !== undefined));
  });
});

const FRAME = { type: 'window_frame', frame: { x: 1000, y: 1000, w: 300, h: 400 }, viewport: 'window' };
const CAPSULES = { type: 'hit_capsules', space: 'global', capsules: [{ a: [1150, 1100], b: [1150, 1300], r: 40 }] };

test('cursor: hit leaves out the above and pass-through rects of setHitExclusions (rules 34, 41); without them the line is as before', { skip: UNIX_LINK }, async () => {
  await withLink({ cursor: () => ({ x: 1150, y: 1200 }) }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: [] });
    a.send(FRAME);
    a.send(CAPSULES);
    const hit = () => a.last('cursor')?.hit;
    assert.ok(await until(1, () => hit() === true));
    assert.ok(a.raw.includes('{"v":1,"type":"cursor","x":150,"y":200,"inside":true,"hit":true}'), a.raw.join('\n'));
    // Global points; a rect contains its min edges and leaves out the max ones.
    link.setHitExclusions({ above: [{ x: 1100, y: 1150, w: 100, h: 100 }], passThrough: [] });
    assert.ok(await until(1, () => hit() === false), 'above');
    link.setHitExclusions({ above: [{ x: 0, y: 0, w: 10, h: 10 }], passThrough: [] });
    assert.ok(await until(1, () => hit() === true), 'above elsewhere');
    link.setHitExclusions({ above: [], passThrough: [{ x: 1150, y: 1200, w: 5, h: 5 }] });
    assert.ok(await until(1, () => hit() === false), 'pass-through, min edge');
    link.setHitExclusions({ above: [], passThrough: [{ x: 1140, y: 1190, w: 10, h: 10 }] });
    assert.ok(await until(1, () => hit() === true), 'pass-through, max edge');
    // Rule 2: a drag holds it true.
    link.setHitExclusions({ above: [{ x: 1100, y: 1150, w: 100, h: 100 }], passThrough: [] });
    assert.ok(await until(1, () => hit() === false));
    a.send({ type: 'drag', phase: 'begin' });
    assert.ok(await until(1, () => hit() === true), 'drag');
    a.socket.destroy();
    // A new connection starts without the last one's rects.
    const b = await attach(link, { pid: 100, capabilities: [] });
    b.send(FRAME);
    b.send(CAPSULES);
    assert.ok(await until(1, () => b.last('cursor')?.hit === true));
    b.socket.destroy();
  });
});

test('cursor: while buttonsDown hit only stays on; a press held since a hit goes past the pass-through rects, not the above ones', { skip: UNIX_LINK }, async () => {
  let down = false;
  await withLink({ cursor: () => ({ x: 1150, y: 1200 }), buttonsDown: () => down }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: [] });
    a.send(FRAME);
    // Fresh capsules, then the hit of a `cursor` three lines (CURSOR.keepalive apart) after the change.
    const hit = async () => {
      a.send(CAPSULES);
      const lines = () => a.got.filter((m) => m.type === 'cursor').length, n = lines();
      assert.ok(await until(1, () => lines() >= n + 3));
      return a.last('cursor')?.hit;
    };
    const on = { above: [], passThrough: [{ x: 1140, y: 1190, w: 20, h: 20 }] };
    const above = { above: [{ x: 1140, y: 1190, w: 20, h: 20 }], passThrough: [] };
    const none = { above: [], passThrough: [] };
    assert.equal(await hit(), true);
    link.setHitExclusions(on);
    assert.equal(await hit(), false, 'pass-through, no button');
    down = true;
    assert.equal(await hit(), false, 'pass-through, held since a miss');
    link.setHitExclusions(none);
    assert.equal(await hit(), false, 'a press that began off her');
    down = false;
    assert.equal(await hit(), true);
    down = true;
    assert.equal(await hit(), true, 'a press on her');
    link.setHitExclusions(on);
    assert.equal(await hit(), true, 'pass-through, held since a hit');
    link.setHitExclusions(above);
    assert.equal(await hit(), false, 'above, held since a hit');
    link.setHitExclusions(none);
    assert.equal(await hit(), false, 'held since the miss over the above rect');
    down = false;
    assert.equal(await hit(), true);
  });
});

test('cursor: clickThroughAll sends hit false except during a drag, off at first and kept across reconnects', { skip: UNIX_LINK }, async () => {
  await withLink({ cursor: () => ({ x: 1150, y: 1200 }) }, async (link) => {
    assert.equal(link.clickThroughAll, false);
    const a = await attach(link, { pid: 99, capabilities: [] });
    a.send(FRAME);
    a.send(CAPSULES);
    const hit = () => a.last('cursor')?.hit;
    assert.ok(await until(1, () => hit() === true));
    link.clickThroughAll = true;
    assert.ok(await until(1, () => hit() === false), 'on');
    a.send({ type: 'drag', phase: 'begin' });
    assert.ok(await until(1, () => hit() === true), 'drag');
    a.send({ type: 'drag', phase: 'end' });
    assert.ok(await until(1, () => hit() === false), 'drag ended');
    a.socket.destroy();
    const b = await attach(link, { pid: 100, capabilities: [] });
    b.send(FRAME);
    b.send(CAPSULES);
    assert.ok(await until(1, () => b.last('cursor') !== undefined));
    await sleep(0.2);
    assert.equal(b.last('cursor')!.hit, false, 'kept across a reconnect');
    assert.equal(link.clickThroughAll, true);
    link.clickThroughAll = false;
    assert.ok(await until(1, () => b.last('cursor')?.hit === true), 'off');
    b.socket.destroy();
  });
});

test('drag: an `end` with x and y is onDragRelease at that point, her renderer\'s and this shell\'s pids excluded', { skip: UNIX_LINK }, async () => {
  const released: { at: { x: number; y: number }; excludedPids: number[] }[] = [];
  await withLink({ onDragRelease: (at, excludedPids) => released.push({ at, excludedPids: [...excludedPids] }) }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: [] });
    a.send({ type: 'drag', phase: 'begin', x: 10, y: 20 });
    a.send({ type: 'drag', phase: 'end' });
    a.send({ type: 'drag', phase: 'end', x: true, y: 5 });
    a.send({ type: 'drag', phase: 'end', x: 640.5, y: 610 });
    assert.ok(await until(1, () => released.length > 0));
    await sleep(0.1);
    assert.deepEqual(released, [{ at: { x: 640.5, y: 610 }, excludedPids: [99, 4242] }]);
    a.socket.destroy();
  });
});

test('cursor: cursorMoved and an attach send the next sample though the pointer stood still (cursorMovedPending)', { skip: UNIX_LINK }, async () => {
  const real = performance.now;
  // A clock that stands still: no keepalive, so only a move, her body near or cursorMovedPending sends a cursor.
  performance.now = () => 5_000_000;
  try {
    await withLink({ cursor: () => ({ x: 5000, y: 5000 }), onSurfaceTrack: () => {} }, async (link) => {
      const a = await attach(link, { pid: 99, capabilities: ['surfaces', 'layering'] });
      const cursors = () => a.got.filter((m) => m.type === 'cursor');
      a.send(FRAME);
      a.send(CAPSULES);
      assert.ok(await until(1, () => cursors().length === 1));
      assert.equal(cursors()[0]!.inside, false);
      a.send({ ...FRAME, frame: { x: 4900, y: 4900, w: 300, h: 400 } });
      await sleep(0.15);
      assert.equal(cursors().length, 1, 'the frame alone sends nothing');
      link.cursorMoved();
      assert.ok(await until(1, () => cursors().length === 2));
      assert.deepEqual(cursors()[1], { v: 1, type: 'cursor', x: 100, y: 100, inside: true, hit: false });
      await sleep(0.1);
      assert.equal(cursors().length, 2, 'once');
      a.send(FRAME);
      await sleep(0.1);
      assert.equal(cursors().length, 2);
      a.send({ type: 'attach', track_id: null });
      assert.ok(await until(1, () => cursors().length === 3));
      assert.equal(cursors()[2]!.inside, false);
      a.socket.destroy();
    });
  } finally {
    performance.now = real;
  }
});

test('camera: sendCameraLive merges samples within 1/30 s and a set_render camera drops the waiting one; sendCloseup, sendPhoto', { skip: UNIX_LINK }, async () => {
  await withLink({ offers: OFFERS }, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: ALL_AVATAR });
    const renders = () => a.got.filter((m) => m.type === 'set_render');
    for (const zoom of [2.2, 2.3, 2.4, 2.5, 2.6]) assert.ok(link.sendCameraLive(-135, 8, zoom));
    assert.ok(await until(1, () => renders().length === 2));
    await sleep(0.1);
    assert.equal(renders().length, 2);
    // The contract's rule 49 (a) example; no `req`.
    assert.ok(a.raw.includes('{"v":1,"type":"set_render","camera":{"yaw":-135,"pitch":8,"zoom":2.2,"live":true}}'), a.raw.join('\n'));
    assert.deepEqual(renders()[1], { v: 1, type: 'set_render', camera: { yaw: -135, pitch: 8, zoom: 2.6, live: true } });
    assert.ok(link.sendCameraLive(10, 0, 1));
    assert.ok(link.sendCameraLive(20, 0, 1));
    assert.ok(link.sendSetRender({ camera: { yaw: 0, pitch: 0 } }));
    await sleep(0.15);
    assert.deepEqual(renders().slice(2).map((m) => m.camera), [{ yaw: 10, pitch: 0, zoom: 1, live: true }, { yaw: 0, pitch: 0 }]);

    assert.ok(link.sendCloseup(true));
    assert.ok(link.sendPhoto(true, 2.8, null));
    assert.ok(link.sendPhoto(false, 32, 1.5));
    assert.equal(link.sendPhoto(true, 50, null), false, 'aperture 1.4–32');
    assert.ok(await until(1, () => renders().length === 7));
    const sent = renders().slice(4).map(({ req, ...m }) => {
      assert.ok(Number.isInteger(req));
      return m;
    });
    assert.deepEqual(sent, [{ v: 1, type: 'set_render', camera: { closeup: true } },
      { v: 1, type: 'set_render', photo: { active: true, aperture: 2.8, focus: 'auto' } },
      { v: 1, type: 'set_render', photo: { active: false, aperture: 32, focus: 1.5 } }]);
    a.socket.destroy();

    const b = await attach(link, { pid: 100, capabilities: ['ack', 'render_live'] });
    assert.equal(link.sendCameraLive(0, 0, 1), false, 'camera_free');
    assert.equal(link.sendCloseup(true), false, 'camera_free');
    assert.equal(link.sendPhoto(true, 2.8, null), false, 'photo');
    b.socket.destroy();
  });
  await withLink({}, async (link) => {
    const a = await attach(link, { pid: 99, capabilities: ALL_AVATAR });
    assert.equal(link.sendCameraLive(0, 0, 1), false, 'this link does not list render_live');
    assert.equal(link.sendCloseup(false), false);
    assert.equal(link.sendPhoto(false, 32, null), false);
    a.socket.destroy();
  });
});

test('action_played with chain is dropped when she does not list play_chain', { skip: UNIX_LINK }, async () => {
  await withLink({}, async (link, log) => {
    const played: unknown[] = [];
    link.on((e) => {
      if (e.kind === 'message' && e.message.type === 'action_played') played.push(e.message.play_id);
    });
    const chain = { type: 'action_played', play_id: 'pc-1', id: 'start_clip', phase: 'started', reason: null, chain: 'start_clip' };
    const a = await attach(link, { pid: 99, capabilities: ['actions'] });
    a.send(chain);
    a.send({ ...chain, play_id: 'p-2', chain: undefined });
    assert.ok(await until(1, () => played.includes('p-2')));
    assert.deepEqual(played, ['p-2']);
    assert.ok(log.includes('rejected type=action_played why=capability'), log.join('\n'));
    a.socket.destroy();
    const b = await attach(link, { pid: 100, capabilities: ['actions', 'play_chain'] });
    b.send(chain);
    assert.ok(await until(1, () => played.includes('pc-1')));
    b.socket.destroy();
  });
});

test('set_presentation: the inputs AvatarPresentationInput.valid takes go out as given; no other reaches the wire', { skip: UNIX_LINK }, async () => {
  await withLink({ onPresentationState: () => {} }, async (link, log) => {
    const a = await attach(link, { pid: 99, capabilities: ['presentation'] });
    const valid: Record<string, unknown>[] = [
      { weather: { condition: 'rain', intensity: 0.5, wetness: 0.2, snow: 0 }, valid_for_seconds: 900 },
      { weather: { condition: 'clear', intensity: 0 } },
      { expression: { pose: 'smile', weight: 1 }, valid_for_seconds: 1 },
      { expression: { pose: null } },
      { face_effect: { index: 3, blend: 0.5 }, valid_for_seconds: 3600 },
      { facial_animation: { id: null } },
      { facial_animation: { id: 'blink', rate: 0.5, weight: 0 } },
      { weather: { condition: 'snow', intensity: 1 }, expression: { pose: 'x'.repeat(256), weight: 0 }, face_effect: { index: 0, blend: 1 },
        facial_animation: { id: 'x'.repeat(64), rate: 2, weight: 1 } },
    ];
    for (const [i, input] of valid.entries()) {
      assert.ok(link.sendSetPresentation(i, 'aster', input), `${JSON.stringify(input)} ${log.at(-1)}`);
      assert.ok(await until(1, () => a.last('set_presentation')?.req === i));
      assert.deepEqual(a.last('set_presentation'), { ...input, v: 1, type: 'set_presentation', req: i, character: 'aster' });
    }
    const invalid: Record<string, unknown>[] = [
      {}, { valid_for_seconds: 60 }, { expression: { pose: null }, mood: 'calm' },
      { weather: { condition: 'hail', intensity: 0 } }, { weather: { condition: 'clear', intensity: 0.5 } },
      { weather: { condition: 'rain', intensity: 1.5 } }, { weather: { condition: 'rain', intensity: 0.5, wetness: 2 } },
      { weather: { condition: 'rain', intensity: 0.5, snow: -0.1 } }, { weather: { condition: 'rain' } },
      { expression: { pose: '', weight: 1 } }, { expression: { pose: 'x'.repeat(257) } }, { expression: { pose: 'smile', weight: -0.1 } },
      { expression: { weight: 1 } }, { expression: { pose: 'smile', extra: 1 } },
      { face_effect: { index: 4, blend: 0 } }, { face_effect: { index: 1.5, blend: 0 } }, { face_effect: { index: 1 } },
      { face_effect: { index: 1, blend: 1.5 } },
      { facial_animation: { id: 'x'.repeat(65) } }, { facial_animation: { id: '' } }, { facial_animation: { id: 'a', rate: 3 } },
      { facial_animation: { id: 'a', weight: 2 } }, { facial_animation: { rate: 1 } },
      { expression: { pose: null }, valid_for_seconds: 0 }, { expression: { pose: null }, valid_for_seconds: 3601 },
      { expression: { pose: null }, valid_for_seconds: '60' },
    ];
    for (const input of invalid) assert.equal(link.sendSetPresentation(50, 'aster', input), false, JSON.stringify(input));
    assert.equal(link.sendSetPresentation(-1, 'aster', { expression: { pose: null } }), false);
    assert.equal(link.sendSetPresentation(51, '', { expression: { pose: null } }), false);
    assert.ok(link.sendSetPresentation(52, 'aster', { expression: { pose: null } }));
    assert.ok(await until(1, () => a.last('set_presentation')?.req === 52));
    assert.ok(!a.got.some((m) => m.type === 'set_presentation' && m.req === 50), 'an invalid one went out');
    assert.equal(log.filter((l) => l.startsWith('not sent type=set_presentation why=')).length, invalid.length);
    a.socket.destroy();
  });
});
