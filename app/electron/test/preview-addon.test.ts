// The macOS preview addon (native/mac/preview.m) in plain Node, built fresh into a temporary directory, against
// test/native/preview-fake-host.c: a child that looks up the addon's rendezvous name as the renderer does, says hello, answers
// `connected` with a JSON event and a 64x32 frame, and echoes every JSON it receives. Pixels are checked in a window
// (preview-window.test.ts).
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildPreviewAddon } from '../native/mac/build.mjs';
import type { PreviewSurface } from '../src/main/preview/session.ts';
import type { PreviewAddon } from '../src/main/preview/window.ts';

const mac = process.platform === 'darwin';
let dir: string, addon: PreviewAddon, fakeHost: string;
const hosts: ChildProcess[] = [];

const spin = async (ms: number, until: () => boolean = () => false) => {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
};

before(() => {
  if (!mac) return;
  dir = mkdtempSync(join(tmpdir(), 'addon-'));
  buildPreviewAddon(join(dir, 'preview.node'));
  addon = createRequire(import.meta.url)(join(dir, 'preview.node')) as PreviewAddon;
  fakeHost = join(dir, 'fake-host');
  execFileSync('xcrun', ['clang', '-O2', '-Wall', '-Werror', '-framework', 'CoreFoundation', '-framework', 'IOSurface',
    join(import.meta.dirname, 'native/preview-fake-host.c'), '-o', fakeHost]);
});

after(() => {
  if (!mac) return;
  addon.stop();
  for (const h of hosts) h.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

interface Host { child: ChildProcess; out: string; exit: number | null }

/** A fake host on the rendezvous name, once it has sent its hello. */
async function spawnHost(): Promise<Host> {
  const child = spawn(fakeHost, [addon.rendezvous()], { stdio: ['ignore', 'pipe', 'inherit'] });
  hosts.push(child);
  const host: Host = { child, out: '', exit: null };
  child.stdout!.on('data', (b: Buffer) => { host.out += b.toString(); });
  child.on('exit', (code) => { host.exit = code ?? -1; });
  await spin(5000, () => host.out.includes('hello') || host.exit !== null);
  assert.equal(host.out, 'hello\n', `fake host exited ${host.exit}`);
  return host;
}

interface Got { json: string; surface: PreviewSurface | null; sequence: number }

const listen = (into: Got[]) => (json: string, surface: PreviewSurface | null, sequence: number) => { into.push({ json, surface, sequence }); };
const events = (got: Got[]) => got.map((g) => (JSON.parse(g.json) as { event: string }).event);

/** A connection's first three messages: the echoed `connected`, the greeting and the frame, checked. */
async function connectedTo(got: Got[]): Promise<void> {
  await spin(3000, () => got.length >= 3);
  assert.deepEqual(events(got), ['echo', 'greeting', 'frame'], JSON.stringify(got.map((g) => g.json)));
  assert.equal(got[0]!.json, '{"event":"echo","length":21,"of":{"event":"connected"}}');
  const id = (JSON.parse(got[1]!.json) as { surface: number }).surface;
  const frame = got[2]!;
  assert.equal(frame.json, '{"event":"frame","load_id":1}');
  assert.equal(frame.sequence, 7);
  assert.ok(frame.surface);
  assert.deepEqual([frame.surface.width, frame.surface.height, frame.surface.id], [64, 32, id]);
  assert.equal(frame.surface.handle.length, 8);
  assert.equal(got[0]!.surface, null);
}

const message = (bytes: number) => {
  const head = '{"op":"pause","pad":"', tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
};

test('rendezvous names this process once; the arguments are checked; nothing is sent before a start', { skip: !mac }, () => {
  assert.equal(addon.rendezvous(), `local.agenticcomplex.companion.preview.${process.pid}`);
  assert.equal(addon.rendezvous(), addon.rendezvous());
  assert.equal(addon.send('{"op":"pause"}'), false);
  assert.throws(() => addon.start('', () => {}), TypeError);
  assert.throws(() => (addon.start as (s: unknown) => void)('svc'), TypeError);
  assert.throws(() => (addon.send as (s: unknown) => void)(3), TypeError);
  assert.equal(addon.mainBundle().identifier, null);
  assert.throws(() => addon.setPreventsActivation(Buffer.alloc(4)), TypeError);
  assert.throws(() => (addon.setPreventsActivation as (h: unknown) => boolean)('window'), TypeError);
  assert.equal(addon.setPreventsActivation(Buffer.alloc(8)), false, 'no view, so no window to answer the selector');
});

let host: Host;
let got: Got[] = [];

test('a start before the hello sends connected after it; the hello reaches nothing, the event and the frame reach JS', { skip: !mac }, async () => {
  addon.start(addon.rendezvous(), listen(got));
  // The page sends at once while the renderer is still starting: up to 16 are kept and follow `connected`.
  for (let i = 0; i < 16; i++) assert.equal(addon.send(`{"op":"view","i":${i}}`), true);
  assert.equal(addon.send('{"op":"view","i":16}'), false, 'past 16 before the hello');
  host = await spawnHost();
  await spin(3000, () => got.length >= 19);
  await spin(200);
  const kept = got.splice(3);
  assert.deepEqual(kept.map((g) => (JSON.parse(g.json) as { of: { i: number } }).of.i), [...Array(16).keys()]);
  await connectedTo(got);
});

test('send reaches the host up to 8192 bytes; over that it returns false and sends nothing', { skip: !mac }, async () => {
  got.length = 0;
  assert.equal(addon.send('{"op":"pause"}'), true);
  assert.equal(addon.send(message(8192)), true);
  assert.equal(addon.send(message(8193)), false);
  await spin(2000, () => got.length >= 2);
  await spin(200);
  assert.deepEqual(got.map((g) => g.json), ['{"event":"echo","length":14,"of":{"op":"pause"}}', '{"event":"echo","length":8192}']);
});

test('stop sends the host disconnected; nothing after it reaches JS and send is false', { skip: !mac }, async () => {
  got.length = 0;
  addon.stop();
  await spin(3000, () => host.exit !== null);
  assert.deepEqual([host.exit, host.out], [0, 'hello\ndisconnected\n']);
  assert.equal(addon.send('{"op":"pause"}'), false);
  await spin(300);
  assert.deepEqual(got, []);
});

test('a host that dies while started gives exactly one disconnected; a host spawned after it on the same name works', { skip: !mac }, async () => {
  got = [];
  const first = await spawnHost();
  // The host's hello has gone out; a start that finds it sends connected right away.
  await spin(200);
  addon.start(addon.rendezvous(), listen(got));
  await connectedTo(got);
  got.length = 0;
  first.child.kill('SIGKILL');
  await spin(3000, () => got.length > 0);
  await spin(300);
  assert.deepEqual(got.map((g) => [g.json, g.surface, g.sequence]), [['{"event":"disconnected"}', null, 0]]);
  assert.equal(addon.send('{"op":"pause"}'), false);

  got.length = 0;
  const second = await spawnHost();
  await spin(300);
  assert.deepEqual(got, [], 'the connection ended with the first host; the second one\'s hello reaches nothing');
  const replaced: Got[] = [];
  addon.start(addon.rendezvous(), listen(replaced));
  const fresh: Got[] = [];
  addon.start(addon.rendezvous(), listen(fresh));
  await spin(3000, () => fresh.some((g) => g.surface !== null));
  await spin(200);
  assert.deepEqual(replaced, [], 'the replaced start delivers nothing');
  assert.ok(events(fresh).includes('frame'), JSON.stringify(fresh.map((g) => g.json)));
  assert.equal(addon.send('{"op":"resume"}'), true);
  await spin(2000, () => fresh.some((g) => g.json.includes('resume')));
  assert.ok(fresh.some((g) => g.json === '{"event":"echo","length":15,"of":{"op":"resume"}}'));
  addon.stop();
  await spin(3000, () => second.exit !== null);
  assert.equal(second.exit, 0);
});
