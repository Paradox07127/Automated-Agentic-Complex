// One shell per support dir (src/main/single-instance.ts) over a fake lock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { singleInstance } from '../src/main/single-instance.ts';

/** Locks keyed by support dir, as Electron's lock is keyed by userData, which index.ts puts under the support dir. */
function fakeLocks() {
  const held = new Set<string>();
  return (supportDir: string) => () => {
    if (held.has(supportDir)) return false;
    held.add(supportDir);
    return true;
  };
}

test('a second shell on the same support dir logs LOCKED and is told to exit; one on another support dir runs', () => {
  const lock = fakeLocks(), lines: string[] = [];
  const run = (supportDir: string, pid: number) => singleInstance({ requestLock: lock(supportDir), pid, appPath: '/A.app',
    log: (l) => lines.push(`${supportDir} ${l}`) });
  assert.equal(run('/s/one', 10), true);
  assert.equal(run('/s/two', 11), true);
  assert.deepEqual(lines, []);
  assert.equal(run('/s/one', 12), false);
  assert.deepEqual(lines, ['/s/one LOCKED pid=12 app=/A.app: another instance holds the single-instance lock']);
});
