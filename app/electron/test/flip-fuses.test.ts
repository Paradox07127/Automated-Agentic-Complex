// tools/release/flip_fuses.mjs on a synthetic staged app: a fuse wire in @electron/fuses' format, never a real Electron.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const SCRIPT = resolve(import.meta.dirname, '../../../tools/release/flip_fuses.mjs');
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FRAMEWORK = 'Contents/Frameworks/Electron Framework.framework/Electron Framework';
// Electron 45's build/fuses/fuses.json5 defaults, in wire order.
const DEFAULTS = '101100011';
const NAMES = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges', 'WasmTrapHandlers'];

/** Sentinel, version byte 1, length byte, one ASCII '0'/'1' per fuse, between unrelated bytes. */
function wire(fuses: string): Buffer {
  return Buffer.concat([Buffer.alloc(4096, 0xcf), Buffer.from(SENTINEL), Buffer.from([1, fuses.length]), Buffer.from(fuses),
    Buffer.alloc(4096, 0xfa)]);
}

function staged(t: { after: (fn: () => void) => void }, framework: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'fuses-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, 'Agentic Complex.app');
  for (const [relative, bytes] of [[FRAMEWORK, framework], ['Contents/MacOS/AgenticComplex', Buffer.from('main executable')]] as const) {
    mkdirSync(dirname(join(app, relative)), { recursive: true });
    writeFileSync(join(app, relative), bytes);
  }
  return app;
}

const flip = (app: string) => spawnSync(process.execPath, [SCRIPT, app], { encoding: 'utf8' });

test('RunAsNode, NODE_OPTIONS and --inspect go off in the framework; every other byte stays', (t) => {
  const app = staged(t, wire(DEFAULTS));
  const result = flip(app);
  assert.equal(result.status, 0, result.stderr);
  const flipped = '000000011';
  assert.deepEqual(readFileSync(join(app, FRAMEWORK)), wire(flipped));
  assert.equal(readFileSync(join(app, 'Contents/MacOS/AgenticComplex'), 'utf8'), 'main executable');
  const read = JSON.parse(result.stdout);
  assert.equal(read.file, FRAMEWORK);
  assert.equal(read.version, '1');
  assert.deepEqual(read.fuses, Object.fromEntries(NAMES.map((name, i) => [name, flipped[i] === '1' ? 'enabled' : 'disabled'])));
  assert.equal(read.fuses.EnableEmbeddedAsarIntegrityValidation, 'disabled');
  assert.equal(read.fuses.OnlyLoadAppFromAsar, 'disabled');
});

test('a framework without a fuse wire is refused and left as it was', (t) => {
  const bytes = Buffer.alloc(8192, 0xcf);
  const app = staged(t, bytes);
  const result = flip(app);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not find sentinel/);
  assert.equal(result.stdout, '');
  assert.deepEqual(readFileSync(join(app, FRAMEWORK)), bytes);
});
