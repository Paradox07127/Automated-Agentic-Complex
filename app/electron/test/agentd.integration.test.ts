// A real agentd on an empty character library, supervised on this checkout's port from a temporary support dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ChildState, stateText } from '../src/common/agentd.ts';
import { launchCharacter } from '../src/common/config.ts';
import { AgentdClient, health } from '../src/main/agentd/client.ts';
import { AgentdSupervisor } from '../src/main/agentd/supervisor.ts';
import { loadConfig } from '../src/main/config.ts';
import { integrationPort } from './port.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const PORT = await integrationPort();

async function until(what: string, ok: () => boolean, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('agentd starts without a character, answers /health, and is restarted after it is killed', { timeout: 240_000 }, async () => {
  // Windows has no bash; the gate gives the host's Python as AGENTD_PYTHON.
  const python = process.platform === 'win32' ? process.env.AGENTD_PYTHON!
    : execFileSync('bash', [join(REPO, 'tools/platform/agentd-python.sh')], { encoding: 'utf8' }).trim();
  const support = mkdtempSync(join(tmpdir(), 'agentd-'));
  const states: string[] = [];
  let supervisor: AgentdSupervisor | undefined;
  try {
    cpSync(join(REPO, 'protocol/character-library/fixtures/empty-library'), join(support, 'library'), { recursive: true });
    const configPath = join(support, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      agentd_dir: join(REPO, 'agent/agentd'), python, agentd_port: PORT, gpu_hold_files: [], support_dir: support,
      agentd_state_dir: join(support, 'agentd'), character_catalog: join(support, 'library/current.json'),
    }));
    const config = loadConfig(configPath);
    supervisor = new AgentdSupervisor({
      config, launcherScript: join(REPO, 'app/Resources/agentd_launcher.py'), character: launchCharacter(config, undefined),
      privacyConfigPath: configPath, onStatus: (s: ChildState) => states.push(stateText(s)),
    });
    const s = supervisor;
    s.start();
    await until('agentd running', () => s.state.kind === 'running' || s.state.kind === 'failed', 120);
    assert.equal(s.state.kind, 'running', `${states.join(' ')}\n${readFileSync(join(support, 'logs/agentd.log'), 'utf8').slice(-4000)}`);
    assert.equal((await health(PORT)).kind, 'ready');
    const client = new AgentdClient(join(support, 'agentd/ui-runtime.json'));
    assert.equal((await client.state()).character, null);

    const first = s.pid!;
    process.kill(first, 'SIGKILL');
    await until('agentd restarted', () => (s.state.kind === 'running' && s.pid !== first) || s.state.kind === 'failed', 120);
    assert.deepEqual(states, ['starting', 'running', 'backoff(1)', 'starting', 'running']);
    assert.equal((await health(PORT)).kind, 'ready');
    assert.equal((await client.state()).character, null);
    const log = readFileSync(join(support, 'logs/companion.log'), 'utf8');
    // Windows has no signals: TerminateProcess leaves exit status 1.
    assert.match(log, process.platform === 'win32' ? /supervisor: exit child=agentd status=1 runtime=/ : /supervisor: exit child=agentd signal=9 runtime=/);

    await s.stop();
    assert.equal(s.state.kind, 'stopped');
    assert.deepEqual(await health(PORT), { kind: 'unreachable' });
    assert.match(readFileSync(join(support, 'logs/companion.log'), 'utf8'), /closed\(quit\) child=agentd reason=companion_exit/);
    assert.match(readFileSync(join(support, 'logs/agentd.log'), 'utf8'), /agentd: shut down cleanly/);
  } finally {
    await supervisor?.stop();
    rmSync(support, { recursive: true, force: true });
  }
});
