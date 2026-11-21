// SIGTERM and SIGINT (src/main/quit.ts): each one quits as the tray's 退出 does. The
// signals go only to a Node child this test starts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { quitOnSignals } from '../src/main/quit.ts';

const POSIX_SIGNALS = process.platform === 'win32' ? 'Windows has no SIGTERM to catch: process.kill ends the child at once' : false;

test('SIGTERM and SIGINT each call quit, every time they come (DispatchSource over SIG_IGN)', () => {
  const listeners = new Map<string, () => void>();
  let quits = 0;
  quitOnSignals({ on: (signal, listener) => listeners.set(signal, listener), quit: () => { quits += 1; } });
  assert.deepEqual([...listeners.keys()], ['SIGTERM', 'SIGINT']);
  listeners.get('SIGTERM')!();
  listeners.get('SIGTERM')!();
  listeners.get('SIGINT')!();
  assert.equal(quits, 3);
});

test('a second signal while the children stop does not kill the process: it exits 0 once the stop is done', { skip: POSIX_SIGNALS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quit-'));
  try {
    const script = join(dir, 'child.mjs');
    // quit() stands for app.quit(): `will-quit` stops the children for 300 ms, then the app exits.
    writeFileSync(script, `import { quitOnSignals } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/main/quit.ts')).href)};
let quits = 0;
quitOnSignals({ on: (s, l) => process.on(s, l), quit: () => {
  quits += 1;
  console.log('quit ' + quits);
  if (quits === 1) setTimeout(() => { console.log('stopped'); process.exit(0); }, 300);
} });
setInterval(() => {}, 1000);
console.log('ready');
`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '', exit: [number | null, NodeJS.Signals | null] | null = null;
    const waiters: (() => void)[] = [];
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      waiters.splice(0).forEach((w) => w());
    });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('close', (code, signal) => {
      exit = [code, signal];
      waiters.splice(0).forEach((w) => w());
      resolve(exit);
    }));
    const seen = (text: string) => new Promise<void>((resolve, reject) => {
      const check = () => {
        if (out.includes(text)) resolve();
        else if (exit) reject(new Error(`child ended ${JSON.stringify(exit)} before ${JSON.stringify(text)}; output ${JSON.stringify(out)}`));
        else waiters.push(check);
      };
      check();
    });
    await seen('ready\n');
    child.kill('SIGTERM');
    await seen('quit 1\n');
    child.kill('SIGINT');
    assert.deepEqual(await closed, [0, null]);
    assert.deepEqual(out.trim().split('\n'), ['ready', 'quit 1', 'quit 2', 'stopped']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
