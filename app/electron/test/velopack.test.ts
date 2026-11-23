// main/velopack.ts on a fake SDK, and the installed velopack package against app/packaging/velopack.lock.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { velopackStartup } from '../src/main/velopack.ts';

const ELECTRON = resolve(import.meta.dirname, '..');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('the startup handling loads the SDK and runs its builder once', async () => {
  const calls: string[] = [];
  await velopackStartup(async () => {
    calls.push('load');
    return { VelopackApp: { build: () => (calls.push('build'), { run: () => { calls.push('run'); } }) } };
  });
  assert.deepEqual(calls, ['load', 'build', 'run']);
});

test('the shell depends on the velopack package of the locked vpk version, with its win-x64 module', () => {
  const lock = json(resolve(ELECTRON, '../packaging/velopack.lock.json'));
  assert.equal(lock.npm_version, lock.version);
  assert.equal(json(resolve(ELECTRON, 'package.json')).dependencies.velopack, lock.npm_version);
  assert.equal(json(resolve(ELECTRON, 'package-lock.json')).packages['node_modules/velopack'].version, lock.npm_version);
  const installed = resolve(ELECTRON, 'node_modules/velopack');
  assert.equal(json(resolve(installed, 'package.json')).version, lock.npm_version);
  assert.match(readFileSync(resolve(installed, 'lib/load.js'), 'utf8'), /native\/velopack_nodeffi_win_x64_msvc\.node/);
});
