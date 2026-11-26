// AgentdSupervisor's `onHealth` against a fake agentd in Node whose /health walks through stages and
// degraded subsystems before it is ready; the host's C6 check of a ready reply; a restart with a catalog set after the launch.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stateText } from '../src/common/agentd.ts';
import { AgentdSupervisor, portAvailable } from '../src/main/agentd/supervisor.ts';
import { loadConfig } from '../src/main/config.ts';

/** Answers /health with each of REPLIES in turn, the last one from then on. */
const FAKE = String.raw`
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const replies = [
  { status: 'starting', stage: 'boot' },
  { status: 'starting', stage: 'boot' },
  { status: 'starting', stage: 'boot', degraded: ['tts'] },
  { status: 'starting', stage: 'memory', degraded: ['tts'] },
  { status: 'ok', degraded: ['tts', 'vision'] },
];
let n = 0;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(replies[Math.min(n++, replies.length - 1)]));
}).listen(port, '127.0.0.1');
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

test('onHealth: each new stage or degraded list while starting, then the degraded list with no stage just after running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs');
  writeFileSync(script, FAKE);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
    agentd_port: await freePort(), support_dir: support, agentd_state_dir: join(dir, 'state') }));
  const seen: string[] = [];
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '',
    onStatus: (s) => seen.push(stateText(s)), onHealth: (stage, degraded) => seen.push(`health ${stage} [${degraded.join(',')}]`) });
  try {
    supervisor.start();
    assert.ok(await until(20, () => supervisor.state.kind === 'running' && seen.length === 6), seen.join('\n'));
    assert.deepEqual(seen, ['starting', 'health boot []', 'health boot [tts]', 'health memory [tts]', 'running', 'health null [tts,vision]']);
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake agentd that answers every /health with `reply`. */
const fakeReady = (reply: Record<string, unknown>) => String.raw`
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http').createServer((req, res) => res.writeHead(200).end(${JSON.stringify(JSON.stringify(reply))})).listen(port, '127.0.0.1');
`;

test('a ready agentd whose c6_contract is not the host\'s C6 fails without a restart; the host\'s version runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-')), support = join(dir, 's');
  mkdirSync(support);
  const configPath = join(dir, 'config.json'), port = await freePort();
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
    agentd_port: port, support_dir: support, agentd_state_dir: join(dir, 'state') }));
  const run = async (contract: string) => {
    const script = join(dir, `agentd-${contract}.cjs`);
    writeFileSync(script, fakeReady({ status: 'ok', degraded: [], c6_contract: contract }));
    const seen: string[] = [];
    const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), launcherScript: script, character: '', c6Contract: '1',
      onStatus: (s) => seen.push(stateText(s)) });
    try {
      supervisor.start();
      await until(10, () => ['running', 'failed'].includes(supervisor.state.kind));
      await new Promise((r) => setTimeout(r, 1500));
      return [...seen, `port free ${await portAvailable(port)}`];
    } finally {
      await supervisor.stop();
    }
  };
  try {
    assert.deepEqual(await run('v2'), ['starting', 'failed(agentd 契约版本不符：v2 ≠ v1)', 'port free true']);
    assert.deepEqual(await run('v1'), ['starting', 'running', 'port free false']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart after config.json names a usable character_catalog starts agentd the first launch left without a library', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'agentd.cjs');
  writeFileSync(script, fakeReady({ status: 'ok', degraded: [] }));
  const configPath = join(dir, 'config.json');
  // As preparePackaged writes it on a first launch without every seed component.
  const first = { characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath,
    agentd_port: await freePort(), support_dir: support, agentd_state_dir: join(dir, 'state'),
    character_library_missing: ['characters.aster'] };
  writeFileSync(configPath, JSON.stringify(first));
  const supervisor = new AgentdSupervisor({ config: loadConfig(configPath), reload: () => loadConfig(configPath), launcherScript: script,
    character: '' });
  try {
    supervisor.start();
    assert.equal(stateText(supervisor.state), 'failed(没有角色库：缺 characters.aster 组件)');
    const catalog = resolve(import.meta.dirname, '../../../agent/agentd/tests/fixtures/characters/current.json');
    writeFileSync(configPath, JSON.stringify({ ...first, character_catalog: catalog }));
    await supervisor.restart();
    assert.ok(await until(10, () => supervisor.state.kind === 'running'), stateText(supervisor.state));
  } finally {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
