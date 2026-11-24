// One shell per support dir (src/main/single-instance.ts) over a fake lock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { singleInstance, type SingleInstanceOptions } from '../src/main/single-instance.ts';

/** Locks keyed by support dir, as Electron's lock is keyed by userData, which index.ts puts under the support dir. */
function fakeLocks() {
  const held = new Set<string>();
  return (supportDir: string) => () => {
    if (held.has(supportDir)) return false;
    held.add(supportDir);
    return true;
  };
}

/** An app whose events are emitted by hand; `showMain` counts. */
function fakeApp() {
  const listeners = new Map<string, (() => void)[]>();
  let ready = () => {};
  const app = {
    shown: 0,
    ready: new Promise<void>((resolve) => { ready = resolve; }),
    on: ((event, listener) => { listeners.set(event, [...listeners.get(event) ?? [], listener]); }) as SingleInstanceOptions['on'],
    emit: (event: string) => { for (const l of listeners.get(event) ?? []) l(); },
    events: () => [...listeners.keys()],
    start: () => ready(),
  };
  return app;
}

const settle = () => new Promise((r) => setImmediate(r));

test('a second shell on the same support dir logs LOCKED and is told to exit; one on another support dir runs', () => {
  const lock = fakeLocks(), lines: string[] = [];
  const run = (supportDir: string, pid: number) => {
    const app = fakeApp();
    return singleInstance({ requestLock: lock(supportDir), on: app.on, ready: app.ready, showMain: () => {}, pid, appPath: '/A.app',
      log: (l) => lines.push(`${supportDir} ${l}`) });
  };
  assert.equal(run('/s/one', 10), true);
  assert.equal(run('/s/two', 11), true);
  assert.deepEqual(lines, []);
  assert.equal(run('/s/one', 12), false);
  assert.deepEqual(lines, ['/s/one LOCKED pid=12 app=/A.app: another instance holds the single-instance lock']);
});

test('a later launch brings the running shell\'s main window forward, once the shell has started', async () => {
  const lock = fakeLocks(), first = fakeApp(), second = fakeApp();
  const options = (app: ReturnType<typeof fakeApp>, pid: number): SingleInstanceOptions => ({
    requestLock: lock('/s/one'), on: app.on, ready: app.ready, showMain: () => { app.shown += 1; }, pid, appPath: '/A.app', log: () => {},
  });
  assert.equal(singleInstance(options(first, 10)), true);
  assert.deepEqual(first.events(), ['second-instance', 'activate']);
  // Before the shell has started: shown after.
  first.emit('second-instance');
  await settle();
  assert.equal(first.shown, 0);
  first.start();
  await settle();
  assert.equal(first.shown, 1);
  first.emit('second-instance');
  first.emit('activate');
  await settle();
  assert.equal(first.shown, 3);
  // The shell that exits listens to nothing.
  assert.equal(singleInstance(options(second, 11)), false);
  assert.deepEqual(second.events(), []);
});
