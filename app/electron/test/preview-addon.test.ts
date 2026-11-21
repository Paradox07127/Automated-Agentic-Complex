// The macOS preview addon (native/mac/preview.m) in plain Node, built fresh into a temporary directory. Plain Node has no app bundle,
// so these drive the client against a service nobody serves, as private/renderer/host PreviewTransportTests does: the connection reports
// `disconnected` once on its own, and each message that leaves the client comes back as one more `disconnected` reply. Frames
// and pixels are checked in a window (preview-window.test.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildPreviewAddon } from '../native/mac/build.mjs';
import type { PreviewAddon } from '../src/main/preview/window.ts';

const mac = process.platform === 'darwin';
let dir: string, addon: PreviewAddon;
let received: string[] = [];

const spin = async (ms: number, until: () => boolean = () => false) => {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
};

before(() => {
  if (!mac) return;
  dir = mkdtempSync(join(tmpdir(), 'addon-'));
  buildPreviewAddon(join(dir, 'preview.node'));
  addon = createRequire(import.meta.url)(join(dir, 'preview.node')) as PreviewAddon;
});

after(() => {
  if (!mac) return;
  addon.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh connection to an absent service, after its own `disconnected`. */
async function absent(): Promise<void> {
  received = [];
  addon.start(`local.agenticcomplex.test.preview-absent.${process.pid}.${Date.now()}`, (json, surface, sequence) => {
    received.push(`${json} ${surface === null ? 'null' : 'surface'} ${sequence}`);
  });
  await spin(2000, () => received.length > 0);
  assert.deepEqual(received, ['{"event":"disconnected"} null 0']);
  await spin(200);
  received = [];
}

const message = (bytes: number) => {
  const head = '{"op":"pause","pad":"', tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
};

test('a failed connection and each reply after it reach JS as disconnected', { skip: !mac }, async () => {
  await absent();
  assert.equal(addon.send(message(8192)), true);
  await spin(2000, () => received.length > 0);
  assert.deepEqual(received, ['{"event":"disconnected"} null 0']);
});

test('JSON over 8192 bytes is dropped without sending', { skip: !mac }, async () => {
  await absent();
  assert.equal(addon.send(message(8193)), false);
  await spin(500);
  assert.deepEqual(received, []);
});

test('after stop nothing is sent or delivered, and a new start replaces the old connection', { skip: !mac }, async () => {
  await absent();
  addon.stop();
  assert.equal(addon.send(message(64)), false);
  await spin(500);
  assert.deepEqual(received, []);
  const first: string[] = [];
  addon.start('local.agenticcomplex.test.preview-absent.first', (json) => first.push(json));
  addon.start('local.agenticcomplex.test.preview-absent.second', (json) => received.push(json));
  await spin(2000, () => received.length > 0);
  await spin(200);
  assert.deepEqual(first, [], 'the replaced connection delivers nothing');
  assert.deepEqual(received, ['{"event":"disconnected"}']);
});

test('the arguments are checked; plain Node has no bundle id, so the service name falls back', { skip: !mac }, () => {
  assert.throws(() => addon.start('', () => {}), TypeError);
  assert.throws(() => (addon.start as (s: unknown) => void)('svc'), TypeError);
  assert.throws(() => (addon.send as (s: unknown) => void)(3), TypeError);
  assert.equal(addon.mainBundle().identifier, null);
  assert.throws(() => addon.setPreventsActivation(Buffer.alloc(4)), TypeError);
  assert.throws(() => (addon.setPreventsActivation as (h: unknown) => boolean)('window'), TypeError);
  assert.equal(addon.setPreventsActivation(Buffer.alloc(8)), false, 'no view, so no window to answer the selector');
});
