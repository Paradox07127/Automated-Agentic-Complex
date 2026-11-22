import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptPasted, adoptPaths, PASTE_MAX } from '../src/main/ops/adopt.ts';

test('dropped paths: a regular file of a scope type becomes a scope_file handle; folders, other types and missing files do not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '名单.xlsx'), 'abc');
  writeFileSync(join(dir, 'run.sh'), 'x');
  mkdirSync(join(dir, 'folder.md'));
  const picked = new Map<string, { purpose: string; path: string }>();
  const got = await adoptPaths([join(dir, '名单.xlsx'), join(dir, 'run.sh'), join(dir, 'folder.md'), join(dir, 'gone.txt'), '', 7], picked);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.displayName, '名单.xlsx');
  assert.equal(got[0]!.size, 3);
  assert.deepEqual(picked.get(got[0]!.handle), { purpose: 'scope_file', path: join(dir, '名单.xlsx') });
  assert.deepEqual(await adoptPaths('not a list', picked), []);
});

test('pasted images are written under the folder and held; other types and oversize images are left out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'paste-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const picked = new Map<string, { purpose: string; path: string }>();
  const png = new Uint8Array([137, 80, 78, 71]).buffer;
  const got = await adoptPasted([{ type: 'image/png', data: png }, { type: 'text/html', data: png },
    { type: 'image/png', data: new ArrayBuffer(PASTE_MAX + 1) }, { type: 'image/png', data: new ArrayBuffer(0) }], picked, join(dir, 'pasted'));
  assert.equal(got.length, 1);
  const path = picked.get(got[0]!.handle)!.path;
  assert.ok(path.startsWith(join(dir, 'pasted')) && path.endsWith('.png'));
  assert.deepEqual([...readFileSync(path)], [137, 80, 78, 71]);
  assert.equal(got[0]!.size, 4);
});
