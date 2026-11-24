// The Windows preview addon (native/win/preview.cpp) under PipeTransport in plain Node, built fresh into a temporary directory,
// against test/native/preview-fake-efw.cpp: a child that opens the pipe as efw does, says hello with its D3D11 adapter's LUID and
// serves frames of a ring of three shared textures of one colour. The fake's --read mode pulls a frame's handle back out of this
// process and prints the texture's pixel. Windows only; the pixels in a page are e2e-headless.test.ts's.
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildPreviewAddonWin } from '../native/win/build.mjs';
import { type PipeAddon, PipeTransport } from '../src/main/preview/pipe.ts';
import type { PreviewSurface } from '../src/main/preview/session.ts';
import { previewPipePath } from '../src/main/renderer/link.ts';
import { buildFakeEfw } from './preview-fake-efw.ts';

const win = process.platform === 'win32';
const SKIP = win ? false : 'the Windows preview addon builds and runs on Windows only';
/** The fake's colour as r,g,b,a. */
const COLOR = '224,128,32,255';
let dir: string, addon: PipeAddon, fakeEfw: string;
const children: ChildProcess[] = [];

before(() => {
  if (!win) return;
  dir = mkdtempSync(join(tmpdir(), 'addon-win-'));
  buildPreviewAddonWin(join(dir, 'preview.node'));
  addon = createRequire(import.meta.url)(join(dir, 'preview.node')) as PipeAddon;
  fakeEfw = buildFakeEfw(dir);
});

after(() => {
  if (!win) return;
  for (const c of children) c.kill();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  } catch {
    // The loaded addon stays until this process exits.
  }
});

const spin = async (ms: number, until: () => boolean) => {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return until();
};

interface Efw { child: ChildProcess; out: () => string[]; exit: number | null }

/** A fake efw on `name`, once it has said hello. */
async function spawnEfw(name: string): Promise<Efw> {
  const child = spawn(fakeEfw, ['--agentic-complex-preview-rendezvous', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let text = '';
  const efw: Efw = { child, out: () => text.split(/\r?\n/).filter(Boolean), exit: null };
  child.stdout!.on('data', (b: Buffer) => { text += b.toString(); });
  child.stderr!.on('data', (b: Buffer) => { text += b.toString(); });
  child.on('exit', (code) => { efw.exit = code ?? -1; });
  assert.ok(await spin(10_000, () => efw.out().length > 0 || efw.exit !== null));
  assert.match(efw.out()[0]!, /^hello [0-9a-f]{8}:[0-9a-f]{8}$/, `fake efw exited ${efw.exit}: ${text}`);
  return efw;
}

interface Got { message: Record<string, unknown>; surface: PreviewSurface | null; sequence: number }
const listen = (into: Got[]) => (json: string, surface: PreviewSurface | null, sequence: number) => {
  into.push({ message: JSON.parse(json) as Record<string, unknown>, surface, sequence });
};
const ops = (efw: Efw) => efw.out().filter((l) => l.startsWith('op ')).map((l) => l.slice(3));

test('adapters lists DXGI\'s with their LUIDs; a write without a connection is false', { skip: SKIP }, () => {
  const list = addon.adapters();
  assert.ok(list.length > 0);
  for (const a of list) {
    assert.match(a.luid, /^[0-9a-f]{8}:[0-9a-f]{8}$/);
    assert.equal(typeof a.software, 'boolean');
    for (const n of [a.vendorId, a.deviceId, a.subSysId, a.revision]) assert.ok(Number.isInteger(n));
  }
  assert.equal(addon.write(0, 'x'), false);
});

test('the pipe serves one efw at a time: kept sends after connected, a ring\'s handles that hold the colour, stop, the efw\'s end and the next efw',
  { skip: SKIP, timeout: 60_000 }, async () => {
    const name = previewPipePath(dir, process.pid);
    const hardware = addon.adapters().find((a) => !a.software) ?? null;
    assert.ok(hardware, 'no hardware adapter');
    const logs: string[] = [];
    const t = new PipeTransport({ addon, name, gpu: async () => hardware, log: (l) => logs.push(l) });
    assert.equal(t.rendezvous(), name);
    assert.throws(() => addon.listen(name, () => {}), /listen once/);
    const got: Got[] = [];
    t.start(name, listen(got));
    assert.equal(t.send(JSON.stringify({ op: 'view', turn: 0 })), true);
    assert.equal(t.send(JSON.stringify({ op: 'load', load_id: 1, output: [256, 240] })), true);
    const efw = await spawnEfw(name);
    assert.equal(efw.out()[0], `hello ${hardware.luid}`);
    assert.ok(await spin(10_000, () => got.some((g) => g.surface !== null)), `${JSON.stringify(got)} ${efw.out().join('|')} ${logs.join('|')}`);
    assert.deepEqual(ops(efw).slice(0, 3), ['connected', 'view', 'load']);
    const first = got.find((g) => g.surface !== null)!;
    assert.deepEqual({ ...first.surface!, handle: null }, { handle: null, width: 256, height: 240, pixelFormat: 87, bytesPerRow: 1024, id: 3 });
    const pixel = execFileSync(fakeEfw, ['--read', String(process.pid), String(first.surface!.handle.readBigUInt64LE())], { encoding: 'utf8' }).trim();
    assert.equal(pixel, COLOR, 'the duplicated handle is the efw\'s texture');
    assert.equal(t.send(JSON.stringify({ op: 'ack', sequence: first.sequence })), true);
    assert.ok(await spin(5000, () => got.filter((g) => g.surface !== null).length >= 2));
    const second = got.filter((g) => g.surface !== null)[1]!;
    assert.equal(second.sequence, first.sequence + 1);
    assert.notEqual(second.surface!.handle.readBigUInt64LE(), first.surface!.handle.readBigUInt64LE(), 'the next slot');

    t.stop();
    assert.ok(await spin(5000, () => ops(efw).includes('disconnected')));
    const again: Got[] = [];
    t.start(name, listen(again));
    assert.ok(await spin(5000, () => ops(efw).filter((o) => o === 'connected').length === 2), 'connected at once to the efw that said hello');
    efw.child.kill();
    assert.ok(await spin(5000, () => again.some((g) => g.message.event === 'disconnected')), 'the efw\'s end is one disconnected');
    assert.equal(again.filter((g) => g.message.event === 'disconnected').length, 1);

    const next: Got[] = [];
    t.start(name, listen(next));
    assert.equal(t.send(JSON.stringify({ op: 'load', load_id: 2, output: [320, 240] })), true);
    const efw2 = await spawnEfw(name);
    assert.ok(await spin(10_000, () => next.some((g) => g.surface !== null)), efw2.out().join('|'));
    assert.deepEqual(ops(efw2).slice(0, 2), ['connected', 'load']);
    assert.equal(next.find((g) => g.surface !== null)!.surface!.width, 320);
    t.stop();
    efw2.child.kill();
    assert.deepEqual(logs, []);
  });
