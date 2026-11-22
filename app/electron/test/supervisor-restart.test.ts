// A restart of agentd or the renderer launches it with config.json read again, and leaves it running when config.json
// does not load. Fake agentd and renderer are Node scripts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliScript, hookScript } from '../src/common/onboarding.ts';
import { AgentdSupervisor } from '../src/main/agentd/supervisor.ts';
import { loadConfig } from '../src/main/config.ts';
import { RendererSupervisor } from '../src/main/renderer/supervisor.ts';

/** Appends its arguments to `launches`, answers /health ok on `--port`, and exits when its stdin ends (Windows' stop). */
const fakeAgentd = (launches: string) => String.raw`
const { appendFileSync } = require('node:fs');
const http = require('node:http');
appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(' ') + '\n');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}')).listen(port, '127.0.0.1');
if (process.platform === 'win32') process.stdin.on('end', () => process.exit(0)).resume();
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !ok()) await new Promise((r) => setTimeout(r, 20));
  return ok();
}

const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);

test('restarting agentd passes config.json as saved since launch; an unreadable one leaves agentd running and is logged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentd-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  const base = { characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath, agentd_port: await freePort(),
    gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') };
  writeFileSync(configPath, JSON.stringify(base));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '',
    reload: () => loadConfig(configPath) });
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    assert.ok(!lines(launches)[0]!.includes('--mute'), lines(launches)[0]);
    writeFileSync(configPath, JSON.stringify({ ...base, mute: true, share_window_text: true }));
    await supervisor.restart();
    assert.ok(await until(20, () => supervisor.state.kind === 'running' && lines(launches).length === 2), JSON.stringify(supervisor.state));
    assert.match(lines(launches)[1]!, / --share-window-text .* --mute /);
    const pid = supervisor.pid;
    writeFileSync(configPath, '{');
    await supervisor.restart();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([supervisor.state.kind, supervisor.pid, lines(launches).length], ['running', pid, 2]);
    assert.match(readFileSync(join(support, 'logs/companion.log'), 'utf8'), /companion: restart backend: config\.json unreadable: \S/);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each agentd launch passes the character the option gives at that launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'character-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
    agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') }));
  let character = 'aster';
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: () => character });
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    character = 'cedar';
    await supervisor.restart();
    assert.ok(await until(20, () => supervisor.state.kind === 'running' && lines(launches).length === 2), JSON.stringify(supervisor.state));
    assert.deepEqual(lines(launches).map((l) => / --character (\S+)/.exec(l)?.[1]), ['aster', 'cedar']);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stop while a restart is stopping agentd wins: agentd stays stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quit-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
    agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') }));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '' });
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    await Promise.all([supervisor.restart(), supervisor.stop()]);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual([supervisor.state.kind, lines(launches).length], ['stopped', 1]);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after stop, the shell\'s quit, neither a restart nor a start launches agentd again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ended-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
    agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') }));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '' });
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    await supervisor.stop();
    await supervisor.restart();
    supervisor.start();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual([supervisor.state.kind, lines(launches).length], ['stopped', 1]);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('starting agentd with coding sessions and external access on writes <support>/bin/agentic-complex-hook (on Windows its .cmd) to run this launch\'s forwarder, and the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-')), support = join(dir, 's');
  mkdirSync(support);
  mkdirSync(join(dir, "it's"));
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: join(dir, "it's"),
    python: process.execPath, agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state'),
    plugins: { coding_sessions: true, external_access: true } }));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '' });
  const windows = process.platform === 'win32', hook = join(support, 'bin', windows ? 'agentic-complex-hook.cmd' : 'agentic-complex-hook');
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    assert.equal(readFileSync(hook, 'utf8'), windows ? hookScript(process.execPath, [], join(dir, "it's"), 'windows').text
      : `#!/bin/sh\nexec '${process.execPath}' '${join(dir, "it'\\''s")}/codex_hook_forward.py' "$@"\n`);
    if (process.platform !== 'win32') assert.equal(statSync(hook).mode & 0o777, 0o755);
    const cli = cliScript(process.execPath, [], join(dir, "it's"), join(dir, 'state'), join(support, 'bin'), windows ? 'windows' : 'mac');
    assert.equal(readFileSync(join(support, 'bin', cli.name), 'utf8'), cli.text);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('starting agentd with coding sessions off and external access on writes no hook script, only the CLI\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nohook-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir,
    python: process.execPath, agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state'),
    plugins: { external_access: true } }));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '' });
  const windows = process.platform === 'win32';
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    assert.deepEqual(readdirSync(join(support, 'bin')), [windows ? 'agentic-complex.cmd' : 'agentic-complex']);
    assert.match(lines(launches)[0]!, / --plugin-off coding_sessions /);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('starting agentd with coding sessions and external access off writes neither the hook script nor the CLI\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nocli-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, fakeAgentd(launches));
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir,
    python: process.execPath, agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') }));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '' });
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running'), JSON.stringify(supervisor.state));
    assert.equal(existsSync(join(support, 'bin')), false);
    assert.match(lines(launches)[0]!, / --plugin-off external_access /);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// An append-only log opens for appending but refuses fchmod.
test('a log whose mode cannot be set fails the agentd launch without keeping its descriptor open',
  { skip: process.platform !== 'darwin' && 'chflags uappnd is macOS only' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fd-')), support = join(dir, 's'), log = join(support, 'logs', 'agentd.log');
    mkdirSync(join(support, 'logs'), { recursive: true });
    writeFileSync(log, '');
    execFileSync('chflags', ['uappnd', log]);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
      agentd_port: await freePort(), gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') }));
    const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: join(dir, 'none.cjs'), character: '' });
    try {
      const before = readdirSync('/dev/fd').length;
      supervisor.start();
      assert.ok(await until(10, () => supervisor.state.kind === 'failed'), JSON.stringify(supervisor.state));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(readdirSync('/dev/fd').length, before);
    } finally {
      await supervisor.stop();
      execFileSync('chflags', ['nouappnd', log]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('restarting the renderer passes config.json as saved since launch; an unreadable one leaves it running and is logged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'avatar.mjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\n`
    + `appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(' ') + '\\n');\nsetInterval(() => {}, 1000);\n`);
  const base = { characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], avatar_executable: process.execPath, agentd_dir: dir, python: '/usr/bin/false',
    agentd_port: 1, support_dir: support, agentd_state_dir: join(dir, 'state'), gpu_hold_files: [] };
  writeFileSync(configPath, JSON.stringify(base));
  const renderer = new RendererSupervisor({ config: loadConfig(configPath), settings: () => ({}), state: () => ({}),
    character: () => 'aster', link: null, captureDir: join(dir, 'captures'), prefix: [script], reload: () => loadConfig(configPath) });
  try {
    renderer.start();
    assert.ok(await until(10, () => lines(launches).length === 1), JSON.stringify(renderer.state));
    assert.ok(lines(launches)[0]!.includes(`--agentic-complex-agentd ${join(dir, 'state')}/events-runtime.json`), lines(launches)[0]);
    writeFileSync(configPath, JSON.stringify({ ...base, agentd_state_dir: join(dir, 'saved') }));
    await renderer.restart();
    assert.ok(await until(10, () => renderer.state.kind === 'running' && lines(launches).length === 2), JSON.stringify(renderer.state));
    assert.ok(lines(launches)[1]!.includes(`--agentic-complex-agentd ${join(dir, 'saved')}/events-runtime.json`), lines(launches)[1]);
    const pid = renderer.pid;
    writeFileSync(configPath, '{');
    await renderer.restart();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([renderer.state.kind, renderer.pid, lines(launches).length], ['running', pid, 2]);
    assert.match(readFileSync(join(support, 'logs/companion.log'), 'utf8'), /companion: restart avatar: config\.json unreadable: \S/);
  } finally {
    await renderer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A RendererSupervisor running a Node script that appends its arguments to `launches` and stays. */
function fakeRenderer(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix)), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'avatar.mjs'), launches = join(dir, 'launches'), configPath = join(dir, 'config.json');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\n`
    + `appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(' ') + '\\n');\nsetInterval(() => {}, 1000);\n`);
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }],
    avatar_executable: process.execPath, agentd_dir: dir, python: '/usr/bin/false', agentd_port: 1, support_dir: support,
    agentd_state_dir: join(dir, 'state'), gpu_hold_files: [] }));
  const renderer = new RendererSupervisor({ config: loadConfig(configPath), settings: () => ({}), state: () => ({}),
    character: () => 'aster', link: null, captureDir: join(dir, 'captures'), prefix: [script] });
  return { dir, support, launches, renderer };
}

test('after stop, the shell\'s quit, neither a restart nor agentd coming up launches the renderer again', async () => {
  const { dir, launches, renderer } = fakeRenderer('ended-avatar-');
  try {
    renderer.start();
    assert.ok(await until(10, () => lines(launches).length === 1), JSON.stringify(renderer.state));
    await renderer.stop();
    await renderer.restart();
    renderer.startIfStopped();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual([renderer.state.kind, lines(launches).length], ['stopped', 1]);
  } finally {
    await renderer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log whose mode cannot be set fails the renderer launch without keeping its descriptor open',
  { skip: process.platform !== 'darwin' && 'chflags uappnd is macOS only' }, async () => {
    const { dir, support, renderer } = fakeRenderer('fd-avatar-'), log = join(support, 'logs', 'avatar.log');
    mkdirSync(join(support, 'logs'), { recursive: true });
    writeFileSync(log, '');
    execFileSync('chflags', ['uappnd', log]);
    try {
      const before = readdirSync('/dev/fd').length;
      renderer.start();
      assert.equal(renderer.state.kind, 'failed', JSON.stringify(renderer.state));
      assert.equal(readdirSync('/dev/fd').length, before);
    } finally {
      await renderer.stop();
      execFileSync('chflags', ['nouappnd', log]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
