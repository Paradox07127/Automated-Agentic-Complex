// What the renderer link reports to agentd (src/main/renderer/reports.ts), against a fake
// agentd that records each request;
// the last test runs the options through a real HostLink and a fake renderer.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { storedSwitches } from '../src/common/looks.ts';
import { AgentdClient } from '../src/main/agentd/client.ts';
import { HostLink } from '../src/main/renderer/link.ts';
import { type ReportPorts, rendererReports } from '../src/main/renderer/reports.ts';
import { FakeAvatar } from './fake-avatar.ts';

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

type Call = [string, string, unknown];

function setup(f: { status?: (method: string, path: string) => number; running?: boolean; settings?: Record<string, unknown>;
  body?: (path: string) => unknown; } = {}) {
  const calls: Call[] = [], log: string[] = [], companion: string[] = [], strokes: string[] = [], waits: number[] = [];
  const state = { running: f.running ?? true, settings: f.settings ?? {} };
  const ports: ReportPorts = {
    agentd: { request: async (method, path, json) => {
      calls.push([method, path, json]);
      const status = f.status?.(method, path) ?? 200;
      if (status < 0) throw new Error('agentd is unreachable');
      const body = f.body?.(path);
      return body === undefined ? { status } : { status, body: Buffer.from(JSON.stringify(body)) };
    } },
    agentdRunning: () => state.running,
    settings: () => state.settings,
    log: (line) => log.push(line),
    companionLog: (line) => companion.push(line),
    stroke: (token) => strokes.push(token),
    wait: async (ms) => { waits.push(ms); },
  };
  return { reports: rendererReports(ports), calls, log, companion, strokes, waits, state };
}
const ACTIONS = { v: 1, type: 'actions', character: 'aster', actions: [], switches: {} } as const;
const actions = (capabilities: unknown, extra: Record<string, unknown> = {}) =>
  ({ kind: 'message' as const, message: { ...ACTIONS, behavior_capabilities: capabilities, ...extra } });

test('speech_cancelled goes to POST /speech/cancel with its reason, each logged with the status', async () => {
  const { reports, calls, log } = setup({ status: () => 503 });
  reports.options.onSpeechCancelled('s1', 'client_cancel');
  assert.ok(await until(1, () => log.length === 1));
  assert.deepEqual(calls, [['POST', '/speech/cancel', { reason: 'client_cancel', speech_id: 's1' }]]);
  assert.deepEqual(log, ['speech_cancel id=s1 reason=client_cancel status=503']);
});

test('each playback goes to POST /speech/playback as given; only a status other than 200 is logged', async () => {
  const { reports, calls, log } = setup({ status: (_m, path) => (path === '/speech/playback' && calls.length > 1 ? 0 : 200) });
  const started = { speech_id: 's1', clause_id: 'c0', state: 'started', sample: 0, rate: 48000, utterance_id: 'u1' };
  reports.options.onPlayback(started);
  assert.ok(await until(1, () => calls.length === 1));
  await sleep(0.05);
  assert.deepEqual(log, []);
  reports.options.onPlayback({ ...started, state: 'ended' });
  assert.ok(await until(1, () => log.length === 1));
  assert.deepEqual(calls.map((c) => c[2]), [started, { ...started, state: 'ended' }]);
  assert.deepEqual(log, ['playback forward speech_id=s1 status=0']);
});

test('a list\'s behavior capabilities go to PUT /behavior/capabilities once per agentd run, again when they change', async () => {
  const { reports, calls } = setup();
  const capabilities = () => calls.filter((c) => c[1] === '/behavior/capabilities');
  const put = (caps: unknown) => ['PUT', '/behavior/capabilities', { character_id: 'aster', capabilities: caps }];
  reports.linkEvent(actions({ short_walk: null, 'sit@window': '没有坐姿' }));
  assert.ok(await until(1, () => capabilities().length === 1));
  assert.deepEqual(capabilities()[0], put({ short_walk: null, 'sit@window': '没有坐姿' }));
  // The same table again, a list with an error, without the field or with an invalid one: nothing.
  reports.linkEvent(actions({ 'sit@window': '没有坐姿', short_walk: null }));
  reports.linkEvent(actions({ short_walk: null }, { error: 'not_ready' }));
  reports.linkEvent({ kind: 'message', message: { ...ACTIONS } });
  reports.linkEvent(actions({ short_walk: true }));
  reports.linkEvent({ kind: 'message', message: { v: 1, type: 'stats', fps: 60, frame_ms_p95: null, gpu_ms: null } });
  await sleep(0.05);
  assert.equal(capabilities().length, 1);
  // AgentdReadyPlan `.relayCapabilities`: a new run needs them again.
  reports.agentdReady();
  assert.ok(await until(1, () => calls.filter((c) => c[1] === '/behavior/capabilities').length === 2));
  reports.linkEvent(actions({ short_walk: '走不了' }));
  assert.ok(await until(1, () => calls.filter((c) => c[1] === '/behavior/capabilities').length === 3));
  assert.deepEqual(calls.filter((c) => c[1] === '/behavior/capabilities').at(-1), put({ short_walk: '走不了' }));
});

test('a 409 is tried again every 250 ms, 12 times in all; an unreachable agentd delivers nothing until the next run', async () => {
  let answer = 409;
  const { reports, calls, waits } = setup({ status: (_m, path) => (path === '/behavior/capabilities' ? answer : 200) });
  const puts = () => calls.filter((c) => c[1] === '/behavior/capabilities').length;
  reports.linkEvent(actions({ short_walk: null }));
  assert.ok(await until(1, () => puts() === 12));
  await sleep(0.05);
  assert.equal(puts(), 12);
  assert.deepEqual(waits, Array(12).fill(250));
  answer = -1;
  reports.agentdReady();
  assert.ok(await until(1, () => puts() === 13));
  answer = 200;
  reports.agentdReady();
  assert.ok(await until(1, () => puts() === 14));
  reports.agentdReady();
  assert.ok(await until(1, () => puts() === 15));
  // Delivered in this run: the same table again sends nothing.
  reports.linkEvent(actions({ short_walk: null }));
  await sleep(0.05);
  assert.equal(puts(), 15);
  assert.equal(waits.length, 12);
});

test('hiding and showing go to PUT /avatar/visibility in order while agentd runs, and again when it starts', async () => {
  const { reports, calls, companion, state } = setup({ status: (method) => (method === 'PUT' ? 500 : 200), running: false });
  reports.visibility(true, 'user');
  await sleep(0.05);
  assert.deepEqual(calls, []);
  state.running = true;
  reports.agentdReady();
  reports.visibility(false, 'fullscreen_exit');
  const visibility = () => calls.filter((c) => c[1] === '/avatar/visibility');
  assert.ok(await until(1, () => visibility().length === 2));
  assert.deepEqual(visibility(), [['PUT', '/avatar/visibility', { visible: false, reason: 'user' }],
    ['PUT', '/avatar/visibility', { visible: true, reason: 'fullscreen_exit' }]]);
  assert.ok(await until(1, () => companion.length === 2));
  assert.deepEqual(companion, ['avatar visibility put visible=false status=500', 'avatar visibility put visible=true status=500']);
});

test('before any hide or show, agentd hears she is visible with no reason', async () => {
  const { reports, calls } = setup();
  reports.agentdReady();
  assert.ok(await until(1, () => calls.length > 0));
  assert.deepEqual(calls[0], ['PUT', '/avatar/visibility', { visible: true, reason: null }]);
});

test('each agentd run gets PUT /behavior/switches and /character/state/switch from config.json after the visibility', async () => {
  const got: [string, string, string, unknown][] = [], answers: Record<string, number> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push([req.method!, req.url!, req.headers.authorization!, JSON.parse(Buffer.concat(chunks).toString('utf8'))]);
      res.writeHead(answers[req.url!] ?? 200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'ready-')), runtime = join(dir, 'ui-runtime.json');
  writeFileSync(runtime, JSON.stringify({ base_url: base, ui_token: 'token-1' }));
  const log: string[] = [];
  let settings: Record<string, unknown> | null = { stay_mode: 'bust', sit_on_windows: false, state_affects_behavior: false };
  const read = () => {
    if (settings === null) throw new Error('config.json is not an object');
    return settings;
  };
  const reports = rendererReports({ agentd: new AgentdClient(runtime), agentdRunning: () => true, settings: read,
    log: (line) => log.push(line), companionLog: () => {}, stroke: () => {} });
  try {
    reports.agentdReady();
    assert.ok(await until(2, () => got.length === 3), JSON.stringify(got));
    assert.deepEqual(got, [
      ['PUT', '/avatar/visibility', 'Bearer token-1', { visible: true, reason: null }],
      ['PUT', '/behavior/switches', 'Bearer token-1',
        { stay_in_place: true, sit_window_top: false, hold_window_edge: true, fullscreen_give_way: true, bust_framing: true }],
      ['PUT', '/character/state/switch', 'Bearer token-1', { affects_behavior: false }],
    ]);
    assert.deepEqual(log, []);
    // agentd started again with a new token and forgot both; config.json changed meanwhile, or no longer reads.
    writeFileSync(runtime, JSON.stringify({ base_url: base, ui_token: 'token-2' }));
    settings = {};
    Object.assign(answers, { '/behavior/switches': 503, '/character/state/switch': 422 });
    reports.agentdReady();
    assert.ok(await until(2, () => got.length === 6), JSON.stringify(got));
    assert.deepEqual(got.slice(4), [
      ['PUT', '/behavior/switches', 'Bearer token-2', { stay_in_place: false, sit_window_top: true, hold_window_edge: true, fullscreen_give_way: true }],
      ['PUT', '/character/state/switch', 'Bearer token-2', { affects_behavior: true }],
    ]);
    assert.ok(await until(1, () => log.length === 2));
    assert.deepEqual(log, ['behavior switches put status=503', 'state switch put status=422']);
    // Unreachable is status 0; a config.json that does not read keeps agentd's defaults (ConfigStore.raw).
    server.close();
    server.closeAllConnections();
    settings = null;
    reports.agentdReady();
    assert.ok(await until(2, () => log.length === 4), JSON.stringify(log));
    assert.deepEqual(log.slice(2), ['behavior switches put status=0', 'state switch put status=0']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('touch switches from config.json as saved now; a stroke goes to the stack', () => {
  const { reports, state, strokes } = setup({ settings: { cheek_pinch: true } });
  assert.deepEqual(reports.options.touchSettings(), { regions: true, pat: true, pinch: true, greet: true });
  state.settings = { touch_regions: false };
  assert.deepEqual(reports.options.touchSettings(), { regions: false, pat: true, pinch: false, greet: true });
  reports.options.onMotionStroke('present-7f3a');
  assert.deepEqual(strokes, ['present-7f3a']);
});

test('through the link: hello lists touch and sends the switches, and each message reaches agentd', { skip: UNIX_LINK }, async () => {
  const { reports, calls, state, strokes } = setup({ settings: { head_pat: false } });
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {}, ...reports.options });
  link.on(reports.linkEvent);
  await link.start();
  const a = new FakeAvatar(link.path);
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: ['touch', 'actions', 'playback'] });
    assert.ok(await until(2, () => a.types().includes('touch_settings')), `${a.types()}`);
    assert.ok((a.got[0]!.capabilities as string[]).includes('touch'));
    assert.deepEqual(a.last('touch_settings'), { v: 1, type: 'touch_settings', regions: true, pat: false, pinch: false, greet: true });
    // Saving the settings sends them again.
    state.settings = {};
    assert.ok(link.touchSettingsChanged());
    assert.ok(await until(1, () => a.got.filter((m) => m.type === 'touch_settings').length === 2));
    assert.equal(a.last('touch_settings')!.pat, true);
    a.send({ type: 'speech_cancelled', speech_id: 's1', reason: 'playback_failed' });
    a.send({ type: 'playback', speech_id: 's1', clause_id: 'c0', state: 'started', sample: 0, rate: 48000 });
    a.send({ ...ACTIONS, behavior_capabilities: { short_walk: null } });
    a.send({ type: 'motion.stroke', token: 'present-7f3a', clip: 'A_snap_start' });
    const forwarded = () => calls.filter((c) => c[1] !== '/behavior/motion_prefs');
    assert.ok(await until(1, () => forwarded().length === 3 && strokes.length === 1), JSON.stringify(calls));
    assert.deepEqual(forwarded().map((c) => `${c[0]} ${c[1]}`).sort(), ['POST /speech/cancel', 'POST /speech/playback', 'PUT /behavior/capabilities']);
    assert.deepEqual(calls.find((c) => c[1] === '/speech/cancel')![2], { reason: 'error', speech_id: 's1' });
    // A dropped link ends the open speech as connection_lost (rule 23).
    a.socket.destroy();
    assert.ok(await until(1, () => forwarded().length === 4));
    assert.deepEqual(forwarded()[3]![2], { speech_id: 's1', clause_id: 'c0', state: 'interrupted', reason: 'connection_lost', sample: 0, rate: 48000 });
  } finally {
    a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const PREFS = {
  action_switches: { aster: { wave: false } },
  motion_overrides: { aster: { chains: { wave: false }, pools: {}, blend_in: { nod: 0.5 }, notes: { wave: '不要挥手' } } },
  stay_mode: 'bust',
};
const NO_OVERRIDES = { chains: {}, pools: {}, blend_in: {} };
const prefs = (switches: Record<string, boolean>,
  overrides: unknown = { chains: { wave: false }, pools: {}, blend_in: { nod: 0.5 } }) =>
  ({ character_id: 'aster', action_switches: switches, motion_overrides: overrides });
const ADJUSTED = { action_switches: { switches: { wave: true }, adjusted: [{ id: 'wave', reason: 'required' }] },
  motion_overrides: { applied: { chains: 1, pools: 0, blend_in: 1 }, adjusted: [] } };

test('her motion settings go to PUT /behavior/motion_prefs once per agentd run and character, again when they change', async () => {
  const { reports, calls, state, log } = setup({ settings: structuredClone(PREFS),
    body: (path) => (path === '/behavior/motion_prefs' ? ADJUSTED : undefined) });
  const puts = () => calls.filter((c) => c[1] === '/behavior/motion_prefs');
  // No character yet, or a list with an error: nothing.
  reports.agentdReady();
  reports.linkEvent({ kind: 'message', message: { ...ACTIONS, error: 'not_ready' } });
  await sleep(0.05);
  assert.deepEqual(puts(), []);
  reports.linkEvent({ kind: 'message', message: { ...ACTIONS } });
  assert.ok(await until(1, () => puts().length === 1));
  assert.deepEqual(puts()[0], ['PUT', '/behavior/motion_prefs', prefs({ wave: false })]);
  assert.ok(await until(1, () => log.length === 1));
  assert.deepEqual(log, ['motion_prefs aster adjusted switches=[{"id":"wave","reason":"required"}] overrides=[]']);
  // The link sent the same settings to her: agentd has them.
  reports.options.onMotionSettings('aster');
  await sleep(0.05);
  assert.equal(puts().length, 1);
  // Saved ones go with the link's message.
  state.settings = { ...PREFS, action_switches: { aster: { wave: true } }, stay_mode: 'roam' };
  reports.options.onMotionSettings('aster');
  assert.ok(await until(1, () => puts().length === 2));
  assert.deepEqual(puts()[1]![2], prefs({ wave: true }));
  // agentd started again and forgot them.
  reports.agentdReady();
  assert.ok(await until(1, () => puts().length === 3));
  assert.deepEqual(puts()[2]![2], prefs({ wave: true }));
  // Another character, with nothing stored.
  reports.linkEvent({ kind: 'message', message: { ...ACTIONS, character: 'birch' } });
  assert.ok(await until(1, () => puts().length === 4));
  assert.deepEqual(puts()[3]![2], { character_id: 'birch', action_switches: {}, motion_overrides: NO_OVERRIDES });
});

test('a 409 character_changed is tried again every 250 ms, 12 times in all; no_motion is not', async () => {
  let error = 'character_changed';
  const { reports, calls, waits, log } = setup({ settings: structuredClone(PREFS),
    status: (_m, path) => (path === '/behavior/motion_prefs' ? 409 : 200),
    body: (path) => (path === '/behavior/motion_prefs' ? { error } : undefined) });
  const puts = () => calls.filter((c) => c[1] === '/behavior/motion_prefs').length;
  reports.options.onMotionSettings('aster');
  assert.ok(await until(1, () => puts() === 12));
  await sleep(0.05);
  assert.equal(puts(), 12);
  assert.deepEqual(waits, Array(12).fill(250));
  error = 'no_motion';
  reports.agentdReady();
  assert.ok(await until(1, () => puts() === 13));
  await sleep(0.05);
  assert.equal(puts(), 13);
  assert.equal(waits.length, 12);
  assert.deepEqual(log.filter((l) => l.startsWith('motion_prefs')), ['motion_prefs aster status=409', 'motion_prefs aster status=409']);
});

test('through the link: each set_action_switches and set_motion_overrides also reaches agentd', { skip: UNIX_LINK }, async () => {
  const { reports, calls, state } = setup({ settings: structuredClone(PREFS) });
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {}, offers: ['render_live', 'motion_overrides', 'camera_bust'],
    remembered: { hiddenLayers: () => null, modSettings: () => ({}), switches: (c) => storedSwitches(state.settings, c) }, ...reports.options });
  await link.start();
  const a = new FakeAvatar(link.path);
  const puts = () => calls.filter((c) => c[1] === '/behavior/motion_prefs').map((c) => c[2]);
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster',
      capabilities: ['actions', 'ack', 'render_live', 'motion_overrides', 'camera_bust'] });
    assert.ok(await until(2, () => link.hello !== null));
    // Her list differs from the stored table: the link sends it (rule 28), and agentd gets it too.
    a.send({ ...ACTIONS });
    assert.ok(await until(1, () => a.types().includes('set_action_switches') && puts().length === 1), JSON.stringify(calls));
    assert.deepEqual(puts(), [prefs({ wave: false })]);
    state.settings = { ...PREFS, action_switches: { aster: { wave: true } } };
    link.saveSwitches('aster', { wave: true }).catch(() => {});
    assert.ok(await until(1, () => puts().length === 2));
    assert.deepEqual(puts()[1], prefs({ wave: true }));
    state.settings = { ...state.settings, motion_overrides: {} };
    link.setMotionOverrides('aster', NO_OVERRIDES).catch(() => {});
    assert.ok(await until(1, () => a.types().includes('set_motion_overrides') && puts().length === 3));
    assert.deepEqual(puts()[2], prefs({ wave: true }, NO_OVERRIDES));
    // Framing reaches agentd through /behavior/switches, so a set_render is not one of them.
    assert.ok(link.sendSetRender({ camera: { framing: 'full' } }));
    await sleep(0.05);
    assert.equal(puts().length, 3);
  } finally {
    a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
