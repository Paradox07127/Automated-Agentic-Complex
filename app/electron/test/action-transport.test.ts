// C3 rule 58 (`action_transport`): the user's desktop play reports where it stands, and the page pauses, resumes and
// seeks it: the message checks, the link's send and receive, and `avatar.controlAction` / `avatar.onActionProgress`.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import { actionProgressProblem, type AvatarHello, type C3Message, decodeLine, outboundProblem } from '../src/common/c3.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { AvatarHost } from '../src/main/ops/avatar.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { MOTION_OFFERS } from '../src/main/renderer/avatar-host.ts';
import { type ActionProgress, HostLink, type LinkEvent } from '../src/main/renderer/link.ts';
import { FakeAvatar } from './fake-avatar.ts';

const PENDING = resolve(import.meta.dirname, '../../../protocol/C3-host-ipc/examples/pending');
const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.01);
  }
  return ok();
}
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => decodeLine(l)!);

test('action_progress: the pending session passes; each bad line names its field', () => {
  const good = lines(join(PENDING, 'avatar-to-companion-action-transport.ndjson')).filter((m) => m.type === 'action_progress');
  assert.ok(good.length >= 5);
  for (const m of good) assert.equal(actionProgressProblem(m), null, JSON.stringify(m));
  const bad = readdirSync(join(PENDING, 'invalid')).filter((f) => f.startsWith('a2c-action-progress-') && !f.includes('without-capability'));
  assert.ok(bad.length >= 4);
  for (const f of bad) assert.notEqual(actionProgressProblem(lines(join(PENDING, 'invalid', f)).at(-1)!), null, f);
  const m = { v: 1, type: 'action_progress', play_id: 'p', t_s: 1, duration_s: 10, paused: false };
  assert.equal(actionProgressProblem({ ...m, t_s: -0.1 }), 't_s');
  assert.equal(actionProgressProblem({ ...m, duration_s: Infinity }), 'duration_s');
  assert.equal(actionProgressProblem({ ...m, play_id: 'x'.repeat(65) }), 'play_id');
});

test('control_action goes out only with a req, a play_id and an op; at_s only with seek, finite and not negative', () => {
  const both = () => true;
  for (const m of lines(join(PENDING, 'companion-to-avatar-action-transport.ndjson')).filter((x) => x.type === 'control_action')) {
    assert.equal(outboundProblem(m, both), null, JSON.stringify(m));
  }
  const bad = readdirSync(join(PENDING, 'invalid')).filter((f) => f.startsWith('c2a-control-action-') && !f.includes('without-capability'));
  assert.ok(bad.length >= 5);
  for (const f of bad) assert.notEqual(outboundProblem(lines(join(PENDING, 'invalid', f)).at(-1)!, both), null, f);
  const seek: C3Message = { v: 1, type: 'control_action', req: 1, play_id: 'p', op: 'seek', at_s: 1 };
  assert.equal(outboundProblem({ ...seek, at_s: NaN }, both), 'at_s');
  assert.equal(outboundProblem({ ...seek, play_id: '' }, both), 'play_id');
});

/** A link offering the motion capabilities, the fake avatar listing `capabilities`. */
async function linked(capabilities: string[], run: (link: HostLink, a: FakeAvatar, events: LinkEvent[], log: string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'c3-at-'));
  const log: string[] = [], events: LinkEvent[] = [];
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => log.push(l), timeScale: 0.05, offers: [...MOTION_OFFERS] });
  link.on((e) => { if (e.kind === 'actionProgress') events.push(e); });
  await link.start();
  const a = new FakeAvatar(link.path);
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities });
    assert.ok(await until(2, () => link.hello?.pid === 99));
    await run(link, a, events, log);
  } finally {
    a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plays `mmd_dance` and answers `started`; resolves with its play_id. */
async function started(link: HostLink, a: FakeAvatar): Promise<string> {
  const play = link.playAction('aster', 'mmd_dance', 1, false);
  assert.ok(await until(2, () => a.last('play_action') !== undefined));
  const playId = a.last('play_action')!.play_id as string;
  a.send({ type: 'action_played', play_id: playId, id: 'mmd_dance', phase: 'started', reason: null });
  await play;
  return playId;
}
const progress = (events: LinkEvent[]) => events.map((e) => (e.kind === 'actionProgress' ? e.progress : undefined));

test('the hello lists action_transport; her progress of the play reaches the page, and its end clears it', { skip: UNIX_LINK }, async () => {
  await linked(['ack', 'actions', 'action_loop', 'action_transport'], async (link, a, events) => {
    assert.ok(await until(2, () => a.last('hello') !== undefined));
    assert.ok((a.last('hello')!.capabilities as string[]).includes('action_transport'));
    const playId = await started(link, a);
    a.send({ type: 'action_progress', play_id: 'someone-else', t_s: 3, duration_s: 9, paused: false });
    a.send({ type: 'action_progress', play_id: playId, t_s: 1.5, duration_s: 184.2, paused: false });
    assert.ok(await until(2, () => events.length === 1));
    const at: ActionProgress = { playId, id: 'mmd_dance', t: 1.5, duration: 184.2, paused: false };
    assert.deepEqual(progress(events), [at]);
    assert.deepEqual(link.actionProgress, at);
    a.send({ type: 'action_played', play_id: playId, id: 'mmd_dance', phase: 'completed', reason: null });
    assert.ok(await until(2, () => events.length === 2));
    assert.deepEqual(progress(events), [at, null]);
    assert.equal(link.actionProgress, null);
  });
});

test('pause, seek and resume go out for the play with a req; her ack settles each', { skip: UNIX_LINK }, async () => {
  await linked(['ack', 'actions', 'action_transport'], async (link, a) => {
    const playId = await started(link, a);
    const pause = link.controlAction('pause');
    assert.ok(await until(2, () => a.last('control_action') !== undefined));
    const sent = a.last('control_action')!;
    assert.deepEqual({ ...sent, req: 0 }, { v: 1, type: 'control_action', req: 0, play_id: playId, op: 'pause' });
    a.send({ type: 'ack', req: sent.req, ok: true });
    await pause;
    const seek = link.controlAction('seek', 90);
    assert.ok(await until(2, () => a.last('control_action')!.op === 'seek'));
    assert.equal(a.last('control_action')!.at_s, 90);
    a.send({ type: 'ack', req: a.last('control_action')!.req, ok: false, error: 'failed' });
    await assert.rejects(seek, { code: 'failed' });
    const resume = link.controlAction('resume');
    assert.ok(await until(2, () => a.last('control_action')!.op === 'resume'));
    a.send({ type: 'ack', req: a.last('control_action')!.req, ok: false, error: 'busy' });
    await assert.rejects(resume, { code: 'busy' });
  });
});

test('without action_transport in her hello nothing goes out and her progress is dropped', { skip: UNIX_LINK }, async () => {
  await linked(['ack', 'actions'], async (link, a, events, log) => {
    const playId = await started(link, a);
    await assert.rejects(link.controlAction('pause'), { code: 'not_implemented' });
    a.send({ type: 'action_progress', play_id: playId, t_s: 1, duration_s: 10, paused: false });
    assert.ok(await until(2, () => log.some((l) => l === 'rejected type=action_progress why=capability')));
    assert.deepEqual(events, []);
    assert.equal(a.last('control_action'), undefined);
  });
});

test('with no play of hers going, controlAction is refused not_playing', { skip: UNIX_LINK }, async () => {
  await linked(['ack', 'actions', 'action_transport'], async (link) => {
    await assert.rejects(link.controlAction('resume'), { code: 'not_playing' });
  });
});

/** A handshaken renderer the ops drive; the test pushes link events. */
class TransportLink implements AvatarHost {
  hello: AvatarHello | null = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['actions', 'ack', 'action_transport'] };
  companionCapabilities = ['actions', 'action_transport'];
  hidden = false;
  currentCharacter: string | null = 'si';
  currentAppearance = null;
  appearances = [];
  layers = [];
  hiddenLayers = [];
  lastStats = null;
  lastPipeline = null;
  lastPlacement = null;
  actionProgress: ActionProgress | null = { playId: 'p1', id: 'mmd_a', t: 2, duration: 12.5, paused: true };
  controls: [string, number | undefined][] = [];
  private listeners = new Set<(e: LinkEvent) => void>();
  setVisible() { return true; }
  stopSpeech() { return true; }
  async actions() { return { v: 1 as const, type: 'actions' as const, character: 'si', switches: {}, actions: [] }; }
  async playAction() {}
  stopAction() {}
  controlAction?: (op: 'pause' | 'resume' | 'seek', at?: number) => Promise<void> = async (op, at) => { this.controls.push([op, at]); };
  on(listener: (e: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: LinkEvent): void { for (const l of [...this.listeners]) l(e); }
}

function opsOn(link: AvatarHost, pushed: unknown[]) {
  const dir = join(tmpdir(), 'c3-at-ops');
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null, store: null,
    diag: null, supervisor: null, library: null, avatar: link, confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
  };
  const ops = registry(ctx);
  const page = new PageSession((_id, stream, kind, payload) => {
    if (stream === 'avatar.onActionProgress' && kind === 'event') pushed.push(JSON.parse(payload!.data));
  });
  return async (op: string, ...args: unknown[]) => {
    const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
    return reply.ok ? reply.value : { error: reply.error };
  };
}

test('avatar.controlAction checks its arguments and asks the link; avatar.onActionProgress pushes the play as it stands, then each change', async () => {
  const link = new TransportLink(), pushed: unknown[] = [];
  const call = opsOn(link, pushed);
  assert.equal(await call('avatar.controlAction', 'pause'), null);
  assert.equal(await call('avatar.controlAction', 'seek', 4.5), null);
  assert.deepEqual(link.controls, [['pause', undefined], ['seek', 4.5]]);
  for (const args of [['stop'], ['seek'], ['seek', -1], ['pause', 3], ['seek', Number.NaN]]) {
    assert.deepEqual(await call('avatar.controlAction', ...args), { error: { code: 'invalid_args', detail: "op pause, resume or seek, and at_s ≥ 0 with seek only" } },
      JSON.stringify(args));
  }
  assert.equal(await call('avatar.onActionProgress', 1), null);
  link.emit({ kind: 'actionProgress', progress: { playId: 'p1', id: 'mmd_a', t: 4.5, duration: 12.5, paused: false } });
  link.emit({ kind: 'actionProgress', progress: null });
  assert.deepEqual(pushed, [{ id: 'mmd_a', tS: 2, durationS: 12.5, paused: true }, { id: 'mmd_a', tS: 4.5, durationS: 12.5, paused: false }, null]);
});

test('without the link’s controlAction, avatar.controlAction is not_implemented', async () => {
  const link = new TransportLink();
  delete link.controlAction;
  const call = opsOn(link, []);
  assert.deepEqual(await call('avatar.controlAction', 'pause'), { error: { code: 'not_implemented', detail: 'avatar.controlAction' } });
});
