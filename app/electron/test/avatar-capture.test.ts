// `avatar.toggleClickThroughAll`, `avatar.photo.set`, `avatar.capture`, `avatar.state.clickThroughAll` and
// `avatar.onStats.cpuPercent` against fake links.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import type { Actions, AvatarHello, C3Message, MotionOverridesReceipt, Stats } from '../src/common/c3.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { type AvatarHost, CpuSampler, psCpuSeconds } from '../src/main/ops/avatar.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { type AvatarLink, CAPTURE_OFFERS, linkAvatarHost } from '../src/main/renderer/avatar-host.ts';
import { ActionFailure, type CommandResult, HostLink, type LinkEvent, type MotionOverrides } from '../src/main/renderer/link.ts';
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

type Shot = { file: string; width: number; height: number };

/** A handshaken renderer as the ops see it; the test sets what photo and capture answer. */
class FakeLink implements AvatarLink {
  hello: AvatarHello | null = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['ack', 'render_live', 'photo', 'capture'] };
  companionCapabilities = ['render_live', 'photo', 'capture'];
  hidden = false;
  currentCharacter: string | null = 'si';
  currentAppearance = null;
  appearances = [];
  layers = [];
  hiddenLayers = [];
  lastStats: Stats | null = null;
  lastPipeline = null;
  lastPlacement = null;
  clickThroughAll = false;
  photos: [boolean, number, number | null][] = [];
  photoSent = true;
  backgrounds: string[] = [];
  shot: () => Promise<Shot> = async () => ({ file: 'Endfield-si-20261120-101010.png', width: 1080, height: 1920 });

  stopSpeech() { return true; }
  async actions(): Promise<Actions> { return { v: 1, type: 'actions', character: 'si', switches: {}, actions: [] }; }
  async playAction() {}
  stopAction() {}
  async setMotionOverrides(character: string, _o: MotionOverrides): Promise<MotionOverridesReceipt> {
    return { req: 1, character, applied: { chains: 0, pools: 0, blend_in: 0 }, adjusted: [], truncated: false };
  }
  playChain(_p: string, _c: string, _s: string, _speed?: number, _r?: (r: CommandResult) => void) { return false; }
  send(_m: C3Message) { return true; }
  on(_l: (e: LinkEvent) => void) { return () => {}; }
  sendPhoto(active: boolean, aperture: number, focus: number | null): boolean {
    this.photos.push([active, aperture, focus]);
    return this.photoSent;
  }
  capture(background = 'transparent'): Promise<Shot> {
    this.backgrounds.push(background);
    return this.shot();
  }
}

interface Fixture {
  dir: string; calls: string[]; ops: ReturnType<typeof registry>;
  call(op: string, ...args: unknown[]): Promise<unknown>;
  done(): void;
}

function fixture(avatar: AvatarHost | null, extra: Partial<OpsContext> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'capture-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ mute: false }));
  const calls: string[] = [];
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null, store: null,
    diag: null, avatar,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }) },
    library: null, confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource,
    log: (line) => calls.push(`log ${line}`), ...extra,
  };
  const ops = registry(ctx), page = new PageSession(() => {});
  return {
    dir, calls, ops,
    call: async (op, ...args) => {
      const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
      return reply.ok ? reply.value : { error: reply.error };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const err = (code: string, detail: string) => ({ error: { code, detail } });

test('avatar.toggleClickThroughAll flips the link\'s click-through all and logs it; avatar.state reports it', async () => {
  const link = new FakeLink(), changed: boolean[] = [];
  const f = fixture(linkAvatarHost(link, () => true, { clickThroughChanged: () => changed.push(link.clickThroughAll) }));
  try {
    assert.equal(((await f.call('avatar.state')) as Record<string, unknown>).clickThroughAll, false);
    assert.equal(await f.call('avatar.toggleClickThroughAll'), null);
    assert.equal(link.clickThroughAll, true);
    assert.equal(((await f.call('avatar.state')) as Record<string, unknown>).clickThroughAll, true);
    assert.equal(await f.call('avatar.toggleClickThroughAll'), null);
    assert.equal(((await f.call('avatar.state')) as Record<string, unknown>).clickThroughAll, false);
    assert.deepEqual(changed, [true, false]);
    assert.deepEqual(f.calls, ['log CLICK_THROUGH on source=menu', 'log CLICK_THROUGH off source=menu']);
    // `speaking` has no source.
    assert.equal(((await f.call('avatar.state')) as Record<string, unknown>).speaking, false);
  } finally {
    f.done();
  }
  // Without a link (config failed) it only logs; the op still answers.
  const none = fixture(null);
  try {
    assert.equal(await none.call('avatar.toggleClickThroughAll'), null);
    assert.deepEqual(none.calls, ['log CLICK_THROUGH source=menu: no avatar link (config failed)']);
  } finally {
    none.done();
  }
  const bare = { ...linkAvatarHost(new FakeLink(), () => true), setClickThroughAll: undefined } as AvatarHost;
  const old = fixture(bare);
  try {
    assert.deepEqual(await old.call('avatar.toggleClickThroughAll'), err('not_implemented', 'avatar.toggleClickThroughAll'));
  } finally {
    old.done();
  }
});

test('avatar.photo.set takes set_render.photo\'s ranges and sends it; unsent or without a link it answers null', async () => {
  const link = new FakeLink();
  const f = fixture(linkAvatarHost(link, () => true));
  try {
    assert.equal(await f.call('avatar.photo.set', { active: true, aperture: 2.8, focus: 'auto' }), null);
    assert.equal(await f.call('avatar.photo.set', { active: false, aperture: 32, focus: 1.5 }), null);
    assert.equal(await f.call('avatar.photo.set', { active: true, aperture: 1.4, focus: 0.1 }), null);
    assert.equal(await f.call('avatar.photo.set', { active: true, aperture: 32, focus: 10 }), null);
    assert.deepEqual(link.photos, [[true, 2.8, null], [false, 32, 1.5], [true, 1.4, 0.1], [true, 32, 10]]);
    const invalid = err('invalid_args', '{active, aperture 1.4–32, focus auto or 0.1–10}');
    for (const bad of [undefined, null, [], { aperture: 2.8, focus: 'auto' }, { active: 1, aperture: 2.8, focus: 'auto' },
      { active: true, aperture: 1.3, focus: 'auto' }, { active: true, aperture: 33, focus: 'auto' }, { active: true, aperture: '2.8', focus: 'auto' },
      { active: true, aperture: 2.8 }, { active: true, aperture: 2.8, focus: 0.05 }, { active: true, aperture: 2.8, focus: 11 },
      { active: true, aperture: 2.8, focus: 'near' }, { active: true, aperture: 2.8, focus: null }]) {
      assert.deepEqual(await f.call('avatar.photo.set', bad), invalid, JSON.stringify(bad));
    }
    assert.equal(link.photos.length, 4);
    // HostLink.sendPhoto false (no `render_live` and `photo` on both sides): the photo is dropped.
    link.photoSent = false;
    assert.equal(await f.call('avatar.photo.set', { active: true, aperture: 4, focus: 'auto' }), null);
  } finally {
    f.done();
  }
  const none = fixture(null);
  try {
    assert.equal(await none.call('avatar.photo.set', { active: true, aperture: 4, focus: 'auto' }), null);
  } finally {
    none.done();
  }
});

test('avatar.capture: background transparent only, the file name of her `captured`, every failure `failed`', async () => {
  const link = new FakeLink(), saved: string[] = [];
  const f = fixture(null);
  const captureDir = join(f.dir, 'Pictures', 'Agentic Complex');
  const g = fixture(linkAvatarHost(link, () => true, { captureDir, captureSaved: (file) => saved.push(file) }));
  try {
    const invalid = err('invalid_args', '{background: transparent}');
    for (const bad of [[], [null], [{}], [{ background: 'stage' }], ['transparent']]) {
      assert.deepEqual(await g.call('avatar.capture', ...bad), invalid, JSON.stringify(bad));
    }
    assert.equal(existsSync(captureDir), false);
    assert.deepEqual(await g.call('avatar.capture', { background: 'transparent' }), { file: 'Endfield-si-20261120-101010.png' });
    // The directory is made before asking; the user is told.
    assert.ok(existsSync(captureDir));
    assert.deepEqual(link.backgrounds, ['transparent']);
    assert.deepEqual(saved, ['Endfield-si-20261120-101010.png']);
    for (const [code, message] of [['unsupported', 'unsupported'], ['busy', 'busy'], ['failed', 'disk_full'], ['failed', 'disconnected'],
      ['timeout', 'timeout']] as const) {
      link.shot = async () => { throw new ActionFailure(code, message); };
      assert.deepEqual(await g.call('avatar.capture', { background: 'transparent' }), err('failed', message), code);
    }
    assert.deepEqual(saved, ['Endfield-si-20261120-101010.png']);
  } finally {
    g.done();
    f.done();
  }
  // No capture directory given: a null `capture`.
  const bare = fixture(linkAvatarHost(new FakeLink(), () => true));
  try {
    assert.deepEqual(await bare.call('avatar.capture', { background: 'transparent' }), err('not_implemented', 'avatar.capture'));
  } finally {
    bare.done();
  }
  const none = fixture(null);
  try {
    assert.deepEqual(await none.call('avatar.capture', { background: 'transparent' }), err('failed', '角色还没连上（配置出错）'));
  } finally {
    none.done();
  }
});

test('CpuSampler is ProcessSampler.sample for one process: the CPU share of one core since the last read; a new pid, an unread process or a still clock start over', () => {
  const s = new CpuSampler();
  assert.equal(s.sample(7, 10, 100), null);
  assert.equal(s.sample(7, 10.5, 101), 0.5);
  assert.equal(s.sample(7, 12.5, 102), 2);
  assert.equal(s.sample(7, 12, 103), 0, 'never below 0');
  assert.equal(s.sample(7, 12, 103), null, 'the clock did not move');
  assert.equal(s.sample(7, 12.25, 104), 0.25);
  assert.equal(s.sample(8, 1, 105), null, 'another process');
  assert.equal(s.sample(8, null, 106), null, 'unread');
  assert.equal(s.sample(8, 2, 107), null, 'the unread one dropped the history');
  assert.equal(s.sample(undefined, 2, 108), null, 'not running');
});

test('avatar.onStats: cpuPercent is the renderer process\'s share of one core ×100 through the cpuSeconds port', async () => {
  const link = new FakeLink();
  link.lastStats = { v: 1, type: 'stats', fps: 50, frame_ms_p95: 21, gpu_ms: null };
  const read: number[] = [];
  const supervisor = { state: () => ({ kind: 'running' }) as const, pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }) as const,
    avatarPid: () => 77 };
  // A process that uses a quarter of a core.
  const sampled = fixture(linkAvatarHost(link, () => true), { supervisor, cpuSeconds: (pid) => {
    read.push(pid);
    return performance.now() / 1000 / 4;
  } });
  const unsampled = fixture(linkAvatarHost(link, () => true), { supervisor });
  const pushes = (f: Fixture) => {
    const pushed: Record<string, unknown>[] = [];
    const page = new PageSession((_id, stream, kind, payload) => {
      if (stream === 'avatar.onStats' && kind === 'event') pushed.push(JSON.parse(payload!.data) as Record<string, unknown>);
    });
    return { pushed, page, reply: handle('main', { mainFrame: true, origin: ORIGIN }, { op: 'avatar.onStats', args: [1] }, f.ops, page) };
  };
  const a = pushes(sampled), b = pushes(unsampled);
  try {
    assert.deepEqual(await a.reply, { ok: true, value: null });
    assert.deepEqual(await b.reply, { ok: true, value: null });
    assert.ok(await until(2.5, () => a.pushed.length >= 2 && b.pushed.length >= 2), `${a.pushed.length} ${b.pushed.length}`);
    assert.deepEqual(a.pushed[0], { fps: 50, frameMs: 20, cpuPercent: 0, frameMsP95: 21 });
    assert.ok(Math.abs((a.pushed[1]!.cpuPercent as number) - 25) < 1, `${a.pushed[1]!.cpuPercent}`);
    assert.ok(read.length >= 2 && read.every((p) => p === 77));
    assert.deepEqual(b.pushed.slice(0, 2).map((p) => p.cpuPercent), [0, 0]);
  } finally {
    a.page.end();
    b.page.end();
    sampled.done();
    unsampled.done();
  }
});

test('psCpuSeconds reads a process\'s user + system CPU time from ps; a gone process is null', { skip: process.platform === 'win32' ? 'ps is macOS\'s' : false }, () => {
  const t = psCpuSeconds(process.pid);
  assert.ok(t !== null && t > 0, `${t}`);
  assert.equal(psCpuSeconds(99_999_999), null);
});

test('over C3: photo.set sends set_render.photo, capture sends `capture` and answers her `captured`, click-through all pins cursor.hit false', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-l-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {}, cursor: () => ({ x: 1150, y: 1200 }), offers: CAPTURE_OFFERS });
  await link.start();
  const saved: string[] = [];
  const captureDir = join(dir, 'Pictures', 'Agentic Complex');
  const f = fixture(linkAvatarHost(link, () => true, { captureDir, captureSaved: (file) => saved.push(file) }));
  try {
    const a = new FakeAvatar(link.path);
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: ['ack', 'render_live', 'photo', 'capture'] });
    assert.ok(await until(2, () => link.hello?.pid === 99));
    a.send({ type: 'window_frame', frame: { x: 1000, y: 1000, w: 300, h: 400 }, viewport: 'window' });
    a.send({ type: 'hit_capsules', space: 'global', capsules: [{ a: [1150, 1100], b: [1150, 1300], r: 40 }] });
    assert.ok(await until(1, () => a.last('cursor')?.hit === true));

    assert.equal(await f.call('avatar.photo.set', { active: true, aperture: 2.8, focus: 'auto' }), null);
    assert.ok(await until(1, () => a.last('set_render') !== undefined));
    const render = a.last('set_render')!;
    assert.deepEqual(render.photo, { active: true, aperture: 2.8, focus: 'auto' });
    assert.equal(typeof render.req, 'number');

    const shot = f.call('avatar.capture', { background: 'transparent' });
    assert.ok(await until(1, () => a.last('capture') !== undefined));
    const req = a.last('capture')!.req;
    assert.equal(a.last('capture')!.background, 'transparent');
    assert.ok(existsSync(captureDir));
    a.send({ type: 'ack', req, ok: true });
    a.send({ type: 'captured', req, file: 'Endfield-aster-20261120-101010.png', width: 1080, height: 1920 });
    assert.deepEqual(await shot, { file: 'Endfield-aster-20261120-101010.png' });
    assert.deepEqual(saved, ['Endfield-aster-20261120-101010.png']);

    assert.equal(await f.call('avatar.toggleClickThroughAll'), null);
    assert.ok(await until(1, () => a.last('cursor')?.hit === false), 'click-through all');
    assert.equal(await f.call('avatar.toggleClickThroughAll'), null);
    assert.ok(await until(1, () => a.last('cursor')?.hit === true), 'off again');
    a.socket.destroy();
  } finally {
    link.stop();
    f.done();
    rmSync(dir, { recursive: true, force: true });
  }
});
