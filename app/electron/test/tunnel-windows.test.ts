// The tunnel's Windows branch against the host itself: its OpenSSH, netstat and tasklist in the host's display language, and
// parent_watch.py's Job Object. ssh only prints its version; no host is reached.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { ownSshListeners, portListeners, tunnelArguments } from '../src/main/tunnel/supervisor.ts';

const WINDOWS_ONLY = process.platform === 'win32' ? false : 'reads the Windows host\'s own OpenSSH, netstat, tasklist and Job Objects';
const REPO = join(import.meta.dirname, '../../..');

test('the ssh.exe path the tunnel builds exists on this host and runs', { skip: WINDOWS_ONLY }, () => {
  const ssh = tunnelArguments('gpu-box', [9880], 'windows')[0]!;
  const version = spawnSync(ssh, ['-V'], { encoding: 'utf8' });
  assert.deepEqual([existsSync(ssh), version.status, /OpenSSH/.test(version.stderr)], [true, 0, true], `${ssh}: ${version.stderr}`);
});

test('netstat and tasklist name this node as the listener of a port it holds, which is not ours', { skip: WINDOWS_ONLY }, async () => {
  const server = createServer();
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  try {
    const listed = await portListeners(port, 'windows');
    assert.deepEqual(listed, [{ pid: process.pid, uid: undefined, command: basename(process.execPath) }]);
    assert.equal(ownSshListeners(listed, 'windows'), false);
  } finally {
    server.close();
  }
});

test('parent_watch.py\'s Windows branch passes its unit test with the host\'s Python', { skip: WINDOWS_ONLY }, () => {
  // The gate gives the host's Python as AGENTD_PYTHON.
  const run = spawnSync(process.env.AGENTD_PYTHON ?? 'python', ['-I', '-B', '-m', 'unittest', 'discover', '-s', join(REPO, 'agent/agentd/tests'),
    '-p', 'test_parent_watch_windows.py'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Ran 3 tests[\s\S]*\nOK\s*$/);
});
