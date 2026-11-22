// The browser extension's native messaging host on Windows (src/main/browser-host.ts) over a fake registry.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOST_KEYS, HOST_NAME, type RegistryPort, syncBrowserHost } from '../src/main/browser-host.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'browser-host-')), browser = join(root, 'agent', 'browser');
  mkdirSync(browser, { recursive: true });
  writeFileSync(join(browser, 'native_host.py'), '');
  writeFileSync(join(browser, 'extension-origin'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/\n');
  const keys = new Map<string, string>(), calls: string[] = [], lines: string[] = [];
  const registry: RegistryPort = {
    set: async (key, value) => { calls.push(`set ${key}`); keys.set(key, value); },
    remove: async (key) => {
      calls.push(`remove ${key}`);
      if (!keys.delete(key)) throw new Error('not there');
    },
  };
  const options = { supportDir: join(root, 'Agentic Complex'), agentdStateDir: join(root, 'state 状态'), python: join(root, 'runtime', 'python', 'python.exe'),
    pythonFlags: ['-I', '-B'], script: join(browser, 'native_host.py'), registry, log: (l: string) => lines.push(l) };
  return { root, keys, calls, lines, options, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('browser host: on, Chrome\'s and Edge\'s HKCU keys name a manifest in the support dir whose .cmd runs python.exe', async () => {
  const h = setup();
  await syncBrowserHost(true, h.options);
  const dir = join(h.options.supportDir, 'native-host'), manifest = join(dir, `${HOST_NAME}.json`);
  assert.deepEqual(HOST_KEYS, ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\local.agenticcomplex.agentd',
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\local.agenticcomplex.agentd']);
  assert.deepEqual([...h.keys], HOST_KEYS.map((k) => [k, manifest]));
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(m, { name: HOST_NAME, description: 'Agentic Complex agentd browser bridge', path: join(dir, 'native-host.cmd'), type: 'stdio',
    allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'] });
  const cmd = readFileSync(join(dir, 'native-host.cmd'), 'utf8');
  assert.equal(cmd, `@echo off\r\nchcp 65001 >nul\r\n"${h.options.python}" -I -B "${h.options.script}" "--state-dir" "${h.options.agentdStateDir}" %*\r\n`);
  assert.deepEqual(h.lines, [`BROWSER_HOST registered ${manifest}`]);
  h.done();
});

test('browser host: turned off it takes the keys and files away; off with nothing registered it touches nothing', async () => {
  const h = setup();
  await syncBrowserHost(false, h.options);
  assert.deepEqual([h.calls, h.lines], [[], []]);
  await syncBrowserHost(true, h.options);
  await syncBrowserHost(false, h.options);
  assert.deepEqual(h.keys.size, 0);
  assert.equal(existsSync(join(h.options.supportDir, 'native-host')), false);
  assert.deepEqual(h.calls.slice(2), HOST_KEYS.map((k) => `remove ${k}`));
  assert.equal(h.lines.at(-1), 'BROWSER_HOST removed');
  h.done();
});

test('browser host: without native_host.py nothing is registered and an earlier registration goes; a key already gone is logged', async () => {
  const h = setup();
  await syncBrowserHost(true, h.options);
  h.keys.delete(HOST_KEYS[1]!);
  rmSync(h.options.script);
  await syncBrowserHost(true, h.options);
  assert.equal(h.keys.size, 0);
  assert.deepEqual(h.lines.slice(1).map((l) => l.replace(/: .*/, '')), ['BROWSER_HOST not registered', `BROWSER_HOST ${HOST_KEYS[1]} not removed`,
    'BROWSER_HOST removed']);
  h.done();
});
