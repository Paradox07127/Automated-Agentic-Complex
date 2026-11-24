// The live preview in a window, end to end: preview-harness.ts runs in a clone of the pinned Electron.app (no Dock icon), launches
// the preview host as its child with `--agentic-complex-preview-rendezvous` (as the shell launches the renderer), and drives
// avatar.preview.* from a page through the real preload.
// Opens a window: runs only with AAC_ELECTRON_PREVIEW=1, under tools/platform/gpu-lock.sh; on Windows in the logged-on user's
// session (in session 0 Chromium composites in software and imports no shared texture).
//   stub: test/native/preview-stub.m serves a known gradient; the page's canvas must hold it at five points.
//   pipe (Windows): test/native/preview-fake-efw.cpp serves textures of one colour over the preview pipe; the page's canvas must
//         hold it.
//   real: with AAC_E2C_HOST (a metal-avatar-host build), AAC_E2C_CATALOG and AAC_E2C_CHARACTER, the renderer itself is the
//         host; AAC_E2C_OUT keeps the screenshot.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build, type BuildOptions } from 'esbuild';
import { buildPreviewAddon } from '../native/mac/build.mjs';
import { buildPreviewAddonWin } from '../native/win/build.mjs';
import { buildFakeEfw } from './preview-fake-efw.ts';

const ROOT = join(import.meta.dirname, '..');
const enabled = process.env.AAC_ELECTRON_PREVIEW === '1' && process.platform === 'darwin';
const windows = process.env.AAC_ELECTRON_PREVIEW === '1' && process.platform === 'win32';
const real = enabled && !!process.env.AAC_E2C_HOST && !!process.env.AAC_E2C_CATALOG && !!process.env.AAC_E2C_CHARACTER;
let dir: string;

before(async () => {
  if (!enabled && !windows) return;
  dir = mkdtempSync(join(tmpdir(), 'window-'));
  (windows ? buildPreviewAddonWin : buildPreviewAddon)(join(dir, 'preview.node'));
  const shared: BuildOptions = { bundle: true, platform: 'node', target: 'node24', external: ['electron'], logLevel: 'warning' };
  await build({ ...shared, entryPoints: [join(ROOT, 'test/preview-harness.ts')], format: 'esm', outfile: join(dir, 'harness.mjs') });
  await build({ ...shared, entryPoints: [join(ROOT, 'src/preload/index.ts')], format: 'cjs', outfile: join(dir, 'preload.cjs') });
});

after(() => {
  if (enabled || windows) rmSync(dir, { recursive: true, force: true });
});

/** A clone of node_modules' Electron.app with no Dock icon, made once. */
function probeApp(): string {
  const app = join(dir, 'Probe.app');
  if (existsSync(app)) return app;
  execFileSync('cp', ['-c', '-R', join(ROOT, 'node_modules/electron/dist/Electron.app'), app]);
  execFileSync('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', join(app, 'Contents/Info.plist')]);
  return app;
}

function runHarness(host: string, out: string, args: string[]): Record<string, unknown> {
  const file = join(out, `e2c-${args[0]}-result.json`);
  rmSync(file, { force: true });
  const run = spawnSync(windows ? join(ROOT, 'node_modules/electron/dist/electron.exe') : join(probeApp(), 'Contents/MacOS/Electron'),
    [join(dir, 'harness.mjs'), join(dir, 'preview.node'), join(dir, 'preload.cjs'), out, host, ...args],
    { encoding: 'utf8', timeout: 120_000 });
  assert.ok(existsSync(file), `no result; status ${run.status}\n${run.stdout}\n${run.stderr.slice(-4000)}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

test('stub host: the page draws the IOSurface it serves, five points exact, and the window can refuse activation', { skip: !enabled }, () => {
  const stub = join(dir, 'preview-stub');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-O2', '-Wall', '-framework', 'Foundation', '-framework', 'IOSurface',
    join(ROOT, 'test/native/preview-stub.m'), '-o', stub]);
  const out = process.env.AAC_E2C_OUT ?? dir;
  const r = runHarness(stub, out, ['stub']);
  console.log(JSON.stringify(r));
  assert.deepEqual(r.show, { ok: true }, JSON.stringify(r.events));
  assert.ok((r.frames as number) >= 2, `frames ${r.frames}`);
  assert.deepEqual(r.sizes, ['256x256 format=42475241 bytesPerRow=1024']);
  assert.equal(r.preventsActivation, true);
  const canvas = r.canvas as { width: number; height: number; points: number[][] };
  assert.equal(canvas.width, 256 * (r.dpr as number));
  const off = canvas.points.filter(([x, y, ...rgba]) => {
    const want = [255 - x!, y!, x!, 255];
    return rgba.some((v, i) => Math.abs(v - want[i]!) > 3);
  });
  assert.deepEqual(off, [], JSON.stringify(canvas.points));
});

test('Windows stub: the page draws the shared texture the fake efw serves over the preview pipe, its colour exact', { skip: !windows }, () => {
  const out = process.env.AAC_E2C_OUT ?? dir;
  const r = runHarness(buildFakeEfw(dir), out, ['pipe']);
  console.log(JSON.stringify(r));
  assert.deepEqual(r.show, { ok: true }, JSON.stringify(r.events));
  assert.ok((r.frames as number) >= 2, `frames ${r.frames}`);
  assert.match((r.sizes as string[]).join(), /^\d+x\d+ format=57 bytesPerRow=\d+$/);
  const canvas = r.canvas as { center: number[] };
  const want = [224, 128, 32, 255];
  assert.ok(canvas.center.every((v, i) => Math.abs(v - want[i]!) <= 3), JSON.stringify(canvas));
});

test('real renderer: its preview draws the character in the page', { skip: !real }, () => {
  const out = process.env.AAC_E2C_OUT ?? dir;
  mkdirSync(out, { recursive: true });
  const r = runHarness(process.env.AAC_E2C_HOST!, out, ['real', process.env.AAC_E2C_CATALOG!, process.env.AAC_E2C_CHARACTER!, ...(process.env.AAC_E2C_ACTION ? [process.env.AAC_E2C_ACTION] : [])]);
  console.log(JSON.stringify(r));
  assert.deepEqual(r.show, { ok: true }, JSON.stringify(r.events));
  assert.ok((r.frames as number) >= 10, `frames ${r.frames}`);
  assert.ok(((r.canvas as { opaque: number }).opaque) > 1000, JSON.stringify(r.canvas));
  assert.ok(readFileSync(r.screenshot as string).length > 0);
});
