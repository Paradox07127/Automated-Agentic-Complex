import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pastedImages } from '../src/common/adoption.ts';
import { checkRequest, RouteTable } from '../src/common/routes.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { test } from 'node:test';
import { adoptPasted, adoptPaths, filePage } from '../src/main/ops/adopt.ts';

test('dropped paths: a regular file of a scope type becomes a scope_file handle; folders, other types and missing files do not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '名单.xlsx'), 'abc');
  writeFileSync(join(dir, 'program.exe'), 'x');
  mkdirSync(join(dir, 'folder.md'));
  const picked = new Map<string, { purpose: string; path: string }>();
  const got = await adoptPaths([join(dir, '名单.xlsx'), join(dir, 'program.exe'), join(dir, 'folder.md'), join(dir, 'gone.txt'), '', 7], picked);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.displayName, '名单.xlsx');
  assert.equal(got[0]!.size, 3);
  assert.deepEqual(picked.get(got[0]!.handle), { purpose: 'scope_file', path: join(dir, '名单.xlsx') });
  assert.deepEqual(await adoptPaths('not a list', picked), []);
});

test('pasted images are written under the folder and held; other types and oversize images are left out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'paste-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const page = new PageSession(() => {});
  const png = new Uint8Array([137, 80, 78, 71]).buffer;
  const got = await adoptPasted([{ type: 'image/png', data: png }, { type: 'text/html', data: png },
    { type: 'image/png', data: new ArrayBuffer(5 * 1024 * 1024 + 1) }, { type: 'image/png', data: new ArrayBuffer(0) }], page, join(dir, 'pasted'));
  assert.equal(got.length, 1);
  const path = page.picked.get(got[0]!.handle)!.path;
  assert.ok(path.startsWith(join(dir, 'pasted')) && path.endsWith('.png'));
  assert.deepEqual([...readFileSync(path)], [137, 80, 78, 71]);
  assert.equal(got[0]!.size, 4);
});

test('an oversized dropped image is refused before the page receives a handle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'image.png');
  writeFileSync(path, new Uint8Array(5 * 1024 * 1024 + 1));
  assert.deepEqual(await adoptPaths([path], new Map()), []);
});

test('one paste, one drop and a scope assembled from multiple drops each enforce sixteen files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'count-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'image.png'), page = new PageSession(() => {});
  writeFileSync(path, new Uint8Array(1));
  const batch = Array(17).fill({ type: 'image/png', data: new ArrayBuffer(1) });
  const dropped = await adoptPaths(Array(17).fill(path), page.picked);
  const pasted = await adoptPasted(batch, page, dir);
  const table = new RouteTable([{ method: 'POST', path: '/agent/scopes', class: 'write', surfaces: ['main'] }]);
  const scope = checkRequest(table, 'main', 'POST', '/agent/scopes', { files: [...dropped, pasted[0]] });
  assert.deepEqual([pastedImages(batch).length, dropped.length, pasted.length, scope.ok], [16, 16, 16, false]);
});

test('ending the page deletes its pasted copies and preserves original files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const page = new PageSession(() => {});
  const original = join(dir, 'original.png');
  writeFileSync(original, new Uint8Array(1));
  await adoptPaths([original], page.picked);
  const [item, remove] = await adoptPasted(Array(2).fill({ type: 'image/png', data: new ArrayBuffer(2) }), page, dir);
  const removed = page.picked.get(remove!.handle)!.path;
  page.release(remove!.handle);
  assert.equal(existsSync(removed), false);
  const path = page.picked.get(item!.handle)!.path;
  page.end();
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(original), true);
});

test('file IPC admits only the registered main surface at its trusted main frame', () => {
  const page = new PageSession(() => {});
  for (const surface of ['main', 'onboarding', 'stack'] as const) {
    for (const origin of [ORIGIN, 'null']) {
      const mainFrame = { origin };
      for (const senderFrame of [mainFrame, { origin }, null]) {
        assert.equal(filePage({ sender: { mainFrame }, senderFrame }, { surface, page }),
          surface === 'main' && origin === ORIGIN && senderFrame === mainFrame ? page : undefined);
      }
    }
  }
});
