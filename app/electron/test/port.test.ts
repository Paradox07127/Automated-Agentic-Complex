// test/port.ts: two test processes that run at once never get one port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/** Starts a process that takes the e2e port and holds it for 20 s; resolves with the port once it has it. */
function holder(): Promise<{ port: number; stop(): void }> {
  const script = `import { e2ePort } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'port.ts')).href)};
console.log(await e2ePort()); setTimeout(() => {}, 20000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d: Buffer) => resolve({ port: Number(String(d).trim()), stop: () => child.kill('SIGKILL') }));
    child.once('exit', (code) => reject(new Error(`the port holder exited ${code} before it printed a port`)));
  });
}

test('two test processes of one checkout that run at once get different ports', async () => {
  const a = await holder();
  try {
    const b = await holder();
    b.stop();
    assert.notEqual(b.port, a.port);
    assert.ok(a.port >= 49045 && a.port <= 49119 && b.port >= 49045 && b.port <= 49119, `${a.port} ${b.port}`);
  } finally {
    a.stop();
  }
});
