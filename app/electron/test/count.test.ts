// test/count.mjs: every test a file declares is counted, however much its process writes before it exits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('count.mjs counts all the tests of files whose results fill the pipe to the runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'count-'));
  try {
    // Megabytes of results, which a forced exit of the runner or of a file's process cuts off.
    const body = Array.from({ length: 400 }, (_, i) => `test('t${i} ${'x'.repeat(2000)}', () => {});`).join('\n');
    const files = Array.from({ length: 8 }, (_, n) => join(dir, `f${n}.test.mjs`));
    for (const file of files) writeFileSync(file, `import { test } from 'node:test';\n${body}\n`);
    // Without NODE_TEST_CONTEXT the inner runner reports as TAP instead of to this one.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const run = spawnSync(process.execPath, [join(import.meta.dirname, 'count.mjs'), 'COUNT', ...files], { encoding: 'utf8', maxBuffer: 1 << 28, env });
    assert.equal(run.stdout.trimEnd().split('\n').at(-1), 'COUNT 3200 passed 0 failed 0 skipped');
    assert.equal(run.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
