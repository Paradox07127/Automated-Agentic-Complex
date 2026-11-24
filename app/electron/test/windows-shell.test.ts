// The shell's Windows forms with the platform passed in: the hook install command and hook script (common/onboarding.ts),
// the diagnostics' build (ops/app.ts) and the hot key defaults (common/settings.ts); on Windows the hook script also runs for real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { cliScript, hookCommand, hookScript } from '../src/common/onboarding.ts';
import { schema } from '../src/common/settings.ts';
import { bundleBuild } from '../src/main/ops/app.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const PY = 'C:\\Users\\x\\Agentic Complex\\resources\\components\\runtime.python\\payload\\python.exe';
const AGENTD = 'C:\\Users\\x\\Agentic Complex\\resources\\components\\agentd\\payload\\agentd';
const SUPPORT = 'C:\\Users\\x\\AppData\\Roaming\\Agentic Complex';

test('on Windows the hook install command is a PowerShell call of single-quoted python, install_hooks.py and the .cmd hook script', () => {
  assert.equal(hookCommand(PY, AGENTD, SUPPORT, { port: 48800, stateDir: 'C:\\L\\agentd' }, 'windows', ['-I', '-B']),
    `& '${PY}' -I -B '${AGENTD}\\tools\\install_hooks.py' --hook-script '${SUPPORT}\\bin\\agentic-complex-hook.cmd'`
    + " --url http://127.0.0.1:48800 --token-file 'C:\\L\\agentd\\hook.token'");
  assert.equal(hookCommand("C:\\O'Brien $x\\python.exe", 'C:\\A', 'C:\\S', { port: 1, stateDir: 'C:\\L' }, 'windows'),
    "& 'C:\\O''Brien $x\\python.exe' 'C:\\A\\tools\\install_hooks.py' --hook-script 'C:\\S\\bin\\agentic-complex-hook.cmd'"
    + " --url http://127.0.0.1:1 --token-file 'C:\\L\\hook.token'");
  assert.equal(hookCommand('/A/python3', '/A/agentd dir', '/S', { port: 48790, stateDir: '/st dir' }, 'mac'),
    "'/A/python3' '/A/agentd dir/tools/install_hooks.py' --hook-script '/S/bin/agentic-complex-hook'"
    + " --url http://127.0.0.1:48790 --token-file '/st dir/hook.token'");
});

test('the hook install command writes hooks /diag/state counts as installed: this launch\'s agentd port and hook.token',
  { skip: process.platform === 'win32' && 'runs the command with /bin/sh', timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-')), settings = join(dir, 'claude', 'settings.json');
    try {
      mkdirSync(join(dir, 'claude'));
      const command = `${hookCommand('/usr/bin/python3', join(REPO, 'agent/agentd'), join(dir, 'support dir'),
        { port: 48790, stateDir: join(dir, 'agentd state') }, 'mac', ['-I'])} --target claude --claude-settings '${settings}'`;
      const code = await new Promise((done) => spawn('/bin/sh', ['-c', command], { stdio: 'ignore' }).on('exit', done));
      assert.equal(code, 0, command);
      const check = ['-I', '-c', 'import json,sys; sys.path.insert(0, sys.argv[1]); from tools import install_hooks as h; '
        + 'print(json.dumps(h.owned(h.load(sys.argv[2]), sys.argv[3])))',
      join(REPO, 'agent/agentd'), settings, 'http://127.0.0.1:48790'];
      const out = await new Promise<string>((done) => {
        let text = '';
        spawn('/usr/bin/python3', check).stdout.on('data', (b: Buffer) => { text += b.toString(); }).on('end', () => done(text));
      });
      const hooks = Object.values(JSON.parse(out) as Record<string, Array<{ hooks: Array<{ command: string }> }>>);
      assert.ok(hooks.length > 0, `no hook for http://127.0.0.1:48790 in ${settings}`);
      for (const [group] of hooks) assert.ok(group!.hooks[0]!.command.includes(`'${join(dir, 'agentd state', 'hook.token')}'`), group!.hooks[0]!.command);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('pasted into PowerShell, the Windows hook install command writes the hook into the settings it is pointed at',
  { skip: process.platform !== 'win32' && 'runs powershell.exe and the host\'s Python', timeout: 60_000 }, async () => {
    const python = process.env.AGENTD_PYTHON;
    assert.ok(python, 'AGENTD_PYTHON');
    const dir = mkdtempSync(join(tmpdir(), "hook 'q' $x-")), settings = join(dir, 'claude', 'settings.json');
    try {
      mkdirSync(join(dir, 'claude'));
      const support = join(dir, 'support dir');
      const command = `${hookCommand(python, join(REPO, 'agent', 'agentd'), support, { port: 48790, stateDir: join(dir, 'agentd state') },
        'windows', ['-I'])} --target claude --claude-settings '${settings.replaceAll("'", "''")}'`;
      const code = await new Promise((done) => spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, stdio: 'ignore' }).on('exit', done));
      assert.equal(code, 0, command);
      // The Claude Code entry is PowerShell too: its quote doubled.
      const hook = JSON.stringify(join(support, 'bin', 'agentic-complex-hook.cmd').replaceAll("'", "''")).slice(1, -1);
      assert.ok(readFileSync(settings, 'utf8').includes(hook), settings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('the hook script is /bin/sh on macOS and a .cmd running this launch\'s forwarder with the hook\'s arguments on Windows', () => {
  assert.deepEqual(hookScript('/py', [], "/a/it's", 'mac'),
    { name: 'agentic-complex-hook', text: "#!/bin/sh\nexec '/py' '/a/it'\\''s/codex_hook_forward.py' \"$@\"\n" });
  assert.deepEqual(hookScript(PY, ['-I', '-B'], AGENTD, 'windows'),
    { name: 'agentic-complex-hook.cmd', text: `@echo off\r\n"${PY}" -I -B "${AGENTD}\\codex_hook_forward.py" %*\r\n` });
});

test('a .cmd whose paths are not ASCII leaves the console code page alone: PowerShell starts the target from UTF-16 text', () => {
  const { name, text } = hookScript("C:\\100%\\it's\\python.exe", ['-I'], 'C:\\用户\\agentd', 'windows');
  assert.equal(name, 'agentic-complex-hook.cmd');
  assert.doesNotMatch(text, /chcp/i);
  assert.match(text, /^[\x20-\x7e\r\n]*$/, 'the .cmd itself is ASCII');
  const lines = text.split('\r\n');
  assert.deepEqual(lines.slice(0, 2), ['@echo off', 'set "AGENTIC_COMPLEX_ARGS=%*"']);
  const m = /^"%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(lines[2]!);
  assert.ok(m, lines[2]);
  const command = Buffer.from(m[1]!, 'base64').toString('utf16le');
  assert.ok(command.includes("FileName='C:\\100%\\it''s\\python.exe'"), command);
  assert.ok(command.includes(`Arguments='-I "C:\\用户\\agentd\\codex_hook_forward.py" '+$env:AGENTIC_COMPLEX_ARGS`), command);
  assert.equal(lines.slice(3).join(''), '');
});

test('the agentic-complex script runs tools/agentic_complex.py on the state dir and names itself as the launcher', () => {
  assert.deepEqual(cliScript('/py', ['-I'], "/a/it's", '/st', '/s/bin', 'mac'), { name: 'agentic-complex',
    text: "#!/bin/sh\nexec '/py' '-I' '/a/it'\\''s/tools/agentic_complex.py' '--state-dir' '/st' '--launcher' '/s/bin/agentic-complex' \"$@\"\n" });
  assert.deepEqual(cliScript(PY, ['-I', '-B'], AGENTD, 'C:\\L\\agentd', 'C:\\S\\bin', 'windows'), { name: 'agentic-complex.cmd',
    text: `@echo off\r\n"${PY}" -I -B "${AGENTD}\\tools\\agentic_complex.py" "--state-dir" "C:\\L\\agentd" "--launcher" "C:\\S\\bin\\agentic-complex.cmd" %*\r\n` });
});

test('on Windows the build is the host component\'s version in the portable directory, else ?', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-')), host = join(dir, 'resources', 'components', 'host');
  try {
    assert.equal(bundleBuild(dir, 'windows'), '?', 'no host component.json');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'component.json'), JSON.stringify({ id: 'host' }));
    assert.equal(bundleBuild(dir, 'windows'), '?', 'no version');
    writeFileSync(join(host, 'component.json'), JSON.stringify({ id: 'host', version: '20261121.2' }));
    assert.equal(bundleBuild(dir, 'windows'), '20261121.2');
    writeFileSync(join(dir, 'Info.plist'), '<plist><dict><key>CFBundleVersion</key><string>1</string></dict></plist>');
    assert.equal(bundleBuild(dir, 'mac'), '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no Windows hot key default holds the Windows key, which the Windows helper refuses', () => {
  const keys = schema('windows').filter((e) => e.kind === 'hotkey');
  assert.ok(keys.length >= 7);
  for (const e of keys) assert.ok(!String(e.default).includes('⌘'), `${String(e.id)} ${String(e.default)}`);
});

test('the generated Windows hook script posts the hook to a fake agentd from a directory with a space',
  { skip: process.platform !== 'win32' && 'runs cmd.exe and the host\'s Python', timeout: 60_000 }, async () => {
    const python = process.env.AGENTD_PYTHON;
    assert.ok(python, 'AGENTD_PYTHON');
    const dir = mkdtempSync(join(tmpdir(), 'hook 测试-')), root = join(dir, 'Agentic Complex');
    const agentd = join(root, 'agentd'), bin = join(root, 'bin'), token = join(root, 'hook.token');
    mkdirSync(agentd, { recursive: true });
    mkdirSync(bin);
    copyFileSync(join(REPO, 'agent/agentd/codex_hook_forward.py'), join(agentd, 'codex_hook_forward.py'));
    writeFileSync(token, 'hook-token\n');
    const { name, text } = hookScript(python, ['-I', '-B'], agentd, 'windows');
    writeFileSync(join(bin, name), text);
    const posts: { url: string; auth: string; observe: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (b: Buffer) => chunks.push(b));
      req.on('end', () => {
        posts.push({ url: req.url ?? '', auth: String(req.headers.authorization), observe: String(req.headers['x-agentd-observe']),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const command = `"${join(bin, name)}" --endpoint /hook/claude --observe --timeout 5 --url http://127.0.0.1:${port} --token-file "${token}"`;
      const child = spawn(command, { shell: true, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (b: Buffer) => { output += b.toString('utf8'); });
      child.stderr.on('data', (b: Buffer) => { output += b.toString('utf8'); });
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'hook-session' }));
      const code = await new Promise<number | null>((r) => child.once('close', r));
      const p = posts[0];
      console.log(`hook run: cwd="${root}" exit=${code} posts=${posts.length} url=${p?.url} auth=${p?.auth} observe=${p?.observe}`
        + ` session=${String(p?.body.session_id)} origin=${typeof p?.body.agentd_origin === 'object'} output=${JSON.stringify(output)}`);
      assert.deepEqual([code, posts.length, p?.url, p?.auth, p?.observe, p?.body.session_id, output],
        [0, 1, '/hook/claude', 'Bearer hook-token', '1', 'hook-session', '']);
      assert.equal(typeof p?.body.agentd_origin, 'object');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
