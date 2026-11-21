// The link's fps tier, over a fake renderer's connection: with
// `idle_low_fps` on she runs at `working` 30 and goes to `interactive` 60 while dragged, hovered, speaking, after her line
// or with a conversation or her bubble on screen; a tier change goes out only when it differs and she is not paused.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostLink, LINK_TIMING, type LinkOptions } from '../src/main/renderer/link.ts';
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
/** LINK_TIMING.lineInteractive (8 s) becomes 0.4 s. */
const SCALE = 0.05;

async function withLink(extra: Partial<LinkOptions>, idleLowFps: boolean,
  body: (link: HostLink, a: FakeAvatar, tiers: () => string[], pointer: { x: number; y: number }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fps-')), pointer = { x: 0, y: 0 };
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps, userFps: 60, batteryLow: true }), log: () => {}, timeScale: SCALE, cursor: () => pointer, ...extra });
  await link.start();
  const a = new FakeAvatar(link.path);
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: ['playback'] });
    assert.ok(await until(2, () => a.types().includes('fps_tier')));
    const tiers = () => a.got.filter((m) => m.type === 'fps_tier').map((m) => `${String(m.tier)} ${String(m.fps)}`);
    await body(link, a, tiers, pointer);
  } finally {
    a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('her line, a conversation or her bubble keep interactive 60; each change goes out once', { skip: UNIX_LINK }, async () => {
  await withLink({}, true, async (link, _a, tiers) => {
    assert.deepEqual(tiers(), ['working 30']);
    link.noteLine();
    assert.ok(await until(1, () => tiers().length === 2), `${tiers()}`);
    assert.deepEqual(tiers(), ['working 30', 'interactive 60']);
    // HostLink.lineInteractive after her last line, the next tick drops the tier.
    assert.ok(await until(LINK_TIMING.lineInteractive * SCALE + 1, () => tiers().length === 3), `${tiers()}`);
    assert.equal(tiers()[2], 'working 30');
    link.setInteractionVisible(true, false);
    link.setInteractionVisible(true, true);
    assert.ok(await until(1, () => tiers().length === 4));
    link.setInteractionVisible(false, true);
    await sleep(0.3);
    assert.equal(tiers().length, 4, 'her bubble still shows');
    link.setInteractionVisible(false, false);
    assert.ok(await until(1, () => tiers().length === 5));
    assert.deepEqual(tiers().slice(3), ['interactive 60', 'working 30']);
  });
});

test('a drag, the pointer on her body and an open speech raise the tier at the next tick', { skip: UNIX_LINK }, async () => {
  await withLink({ onPlayback: () => {} }, true, async (_link, a, tiers, pointer) => {
    a.send({ type: 'drag', phase: 'begin' });
    assert.ok(await until(1, () => tiers().length === 2));
    a.send({ type: 'drag', phase: 'end' });
    assert.ok(await until(1, () => tiers().length === 3));
    pointer.x = 1150;
    pointer.y = 1200;
    a.send({ type: 'hit_capsules', space: 'global', capsules: [{ a: [1150, 1100], b: [1150, 1300], r: 40 }] });
    assert.ok(await until(1, () => tiers().length === 4));
    pointer.x = 500;
    assert.ok(await until(1, () => tiers().length === 5));
    a.send({ type: 'playback', speech_id: 's1', clause_id: 'c0', state: 'started', sample: 0, rate: 48000 });
    assert.ok(await until(1, () => tiers().length === 6));
    a.send({ type: 'playback', speech_id: 's1', clause_id: 'c0', state: 'buffering', sample: 24000, rate: 48000 });
    await sleep(0.3);
    assert.equal(tiers().length, 6);
    a.send({ type: 'playback', speech_id: 's1', clause_id: 'c0', state: 'ended', sample: 48000, rate: 48000 });
    assert.ok(await until(1, () => tiers().length === 7));
    assert.deepEqual(tiers(), ['working 30', 'interactive 60', 'working 30', 'interactive 60', 'working 30', 'interactive 60', 'working 30']);
  });
});

test('hidden or paused, a change waits; showing or resuming sends the current tier', { skip: UNIX_LINK }, async () => {
  await withLink({}, true, async (link, _a, tiers) => {
    link.setVisible(false);
    assert.ok(await until(1, () => tiers().length === 2));
    link.setInteractionVisible(true, false);
    await sleep(0.3);
    assert.deepEqual(tiers(), ['working 30', 'paused 0']);
    link.setVisible(true);
    assert.ok(await until(1, () => tiers().length === 3));
    assert.equal(tiers()[2], 'interactive 60');
    link.setSystemPaused(true);
    link.setInteractionVisible(false, false);
    link.setSystemPaused(false);
    assert.ok(await until(1, () => tiers().length === 5));
    assert.deepEqual(tiers().slice(3), ['paused 0', 'working 30']);
  });
});

test('with idle_low_fps off she stays interactive and activity sends nothing', { skip: UNIX_LINK }, async () => {
  await withLink({}, false, async (link, a, tiers) => {
    link.noteLine();
    link.setInteractionVisible(true, true);
    a.send({ type: 'drag', phase: 'begin' });
    a.send({ type: 'drag', phase: 'end' });
    link.setInteractionVisible(false, false);
    await sleep(0.3);
    assert.deepEqual(tiers(), ['interactive 60']);
  });
});
