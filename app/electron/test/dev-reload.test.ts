// A dev deployment's reload (src/main/dev-reload.ts): tools/release/dev_deploy.py
// switches `<base>/current` to a new deployment in one rename, the receipt's `part` says what to reload. Temporary directories.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { devReload } from '../src/main/dev-reload.ts';

const SYMLINK = process.platform === 'win32' ? 'dev_deploy.py switches `current` as a symlink and runs on macOS only' : false;

function harness() {
  const base = mkdtempSync(join(tmpdir(), 'dev-'));
  const calls: string[] = [], lines: string[] = [];
  let n = 0;
  /** dev_deploy.py deploy and switch_current: a new deployment directory, then `current` renamed onto a link to it. */
  const deploy = (receipt: Record<string, unknown> | string) => {
    n += 1;
    const name = `d${n}`;
    mkdirSync(join(base, name));
    writeFileSync(join(base, name, 'dev-receipt.json'), typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
    symlinkSync(name, join(base, '.current-1'));
    renameSync(join(base, '.current-1'), join(base, 'current'));
  };
  const ports = { reloadWeb: () => calls.push('web'), restartBackend: () => calls.push('agentd'), log: (l: string) => lines.push(l) };
  const until = async (what: () => boolean, label: string): Promise<void> => {
    for (const end = Date.now() + 5000; !what(); await new Promise((r) => setTimeout(r, 20))) {
      if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);
    }
  };
  return { base, calls, lines, deploy, ports, until, done: () => rmSync(base, { recursive: true, force: true }) };
}

const receipt = (part: string, commit = 'abc1234', dirty = false) => ({ schema: 'endfield-dev-runtime/v1', commit, dirty, part,
  created: `${Math.random()}`, ui_sha256: 'u', agentd_sha256: 'a' });

test('without dev_resources nothing is watched and nothing logged (DevResources.listen gives nil)', () => {
  const h = harness();
  try {
    devReload({ devResources: null, ...h.ports }).stop();
    assert.deepEqual([h.calls, h.lines], [[], []]);
  } finally {
    h.done();
  }
});

test('launch logs dev_resources with its receipt; each switch of current reloads what its part says, the launch\'s does not',
  { skip: SYMLINK }, async () => {
    const h = harness();
    h.deploy(receipt('all', 'c0ffee1', true));
    const dev = join(h.base, 'current');
    const reloader = devReload({ devResources: dev, ...h.ports });
    try {
      assert.deepEqual(h.lines, [`dev_resources ${dev} commit=c0ffee1 dirty`]);
      // A staging directory in the base is no deployment.
      mkdirSync(join(h.base, '.staging-x'));
      h.deploy(receipt('web', 'beef001'));
      await h.until(() => h.calls.length >= 1, 'the web reload');
      h.deploy(receipt('agentd', 'beef002', true));
      await h.until(() => h.calls.length >= 2, 'the agentd restart');
      h.deploy(receipt('all', 'beef003'));
      await h.until(() => h.calls.length >= 4, 'the reload of both');
      assert.deepEqual(h.calls, ['web', 'agentd', 'web', 'agentd']);
      assert.deepEqual(h.lines.slice(1), ['dev reload web commit=beef001', 'dev reload agentd commit=beef002 dirty', 'dev reload all commit=beef003']);
    } finally {
      reloader.stop();
      h.done();
    }
  });

test('reconciles a changed receipt even without a rename in the watched parent', { skip: SYMLINK }, async () => {
  const h = harness();
  h.deploy(receipt('all'));
  const dev = join(h.base, 'current');
  const reloader = devReload({ devResources: dev, ...h.ports });
  try {
    writeFileSync(join(dev, 'dev-receipt.json'), JSON.stringify(receipt('web', 'second')));
    await h.until(() => h.calls.length > 0, 'the web reload');
    writeFileSync(join(dev, 'dev-receipt.json'), JSON.stringify(receipt('agentd', 'third')));
    await h.until(() => h.calls.length > 1, 'the backend reload');
    assert.deepEqual(h.calls, ['web', 'agentd']);
  } finally {
    reloader.stop();
    h.done();
  }
});

test('a receipt without a known part reloads nothing; one without the Receipt fields logs commit=none', { skip: SYMLINK }, async () => {
  const h = harness();
  const dev = join(h.base, 'current');
  const reloader = devReload({ devResources: dev, ...h.ports });
  try {
    assert.deepEqual(h.lines, [`dev_resources ${dev} commit=none`]);
    // Each waits for the watcher to read it: a later deployment would hide it.
    h.deploy(receipt('shell'));
    await new Promise((r) => setTimeout(r, 300));
    h.deploy('{');
    await new Promise((r) => setTimeout(r, 300));
    h.deploy({ part: 'web' });
    await h.until(() => h.calls.length >= 1, 'the web reload');
    assert.deepEqual(h.calls, ['web']);
    assert.deepEqual(h.lines.slice(1), ['dev reload web commit=none']);
  } finally {
    reloader.stop();
    h.done();
  }
});
