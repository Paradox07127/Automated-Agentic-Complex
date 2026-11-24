// The computer control host wired as index.ts wires it (src/main/control/shell.ts): a fake platform helper that answers
// `control.listen` without a socket, config.json in a temp dir and the ops over OpsContext. Nothing here observes, acts on
// or reads a real window.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { controlEndpoint } from '../src/common/agentd.ts';
import { DEFAULT_PLUGINS } from '../src/common/plugins.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { shellControl } from '../src/main/control/shell.ts';
import { computerUseOps } from '../src/main/ops/computer-use.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { shellPlatform } from '../src/main/platform/index.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

function setup(o: { argv?: string[]; config?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'control-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, o.config ?? JSON.stringify({ plugins: { computer_use: true } }));
  const requests: [string, Record<string, unknown>][] = [];
  const logs: string[] = [];
  let loads = 0;
  const control = shellControl({
    argv: o.argv ?? ['electron', '.'],
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        if (op === 'control.listen') return ok({ endpoint: params.endpoint });
        if (op === 'input.watch') return ok({ watching: params.enabled === true });
        if (op === 'permissions.status') return ok({ accessibility: 'granted', screenRecording: 'granted' });
        if (op === 'control.respond') return ok({ sent: true });
        if (op === 'apps.running') return ok({ apps: [{ pid: 800, name: 'Notes', app_id: 'com.example.notes', launched_at: 2000 },
          { pid: process.pid, name: 'Shell', app_id: 'com.example.shell', launched_at: 4000 }] });
        if (op === 'windows.list') return ok({ windows: [{ window_id: 77, pid: 800, bounds: { x: 0, y: 0, width: 9, height: 9 }, layer: 0, title: 'a' },
          { window_id: 10, pid: process.pid, bounds: { x: 0, y: 0, width: 9, height: 9 }, layer: 0, title: 'b' }] });
        return { ok: false, error: { code: 'unsupported' } };
      },
    },
    supportDir: dir, configPath, agentdStateDir: dir,
    saved: (path) => {
      loads += 1;
      const v = JSON.parse(readFileSync(path, 'utf8')) as { plugins?: { computer_use?: unknown } };
      const on = v.plugins?.computer_use;
      if (typeof on !== 'boolean') throw new Error('does not load');
      return { plugins: { ...DEFAULT_PLUGINS, computer_use: on } };
    },
    ownPids: () => [process.pid],
    log: (line) => logs.push(line),
  });
  /** agentd's `desktop_status` through the helper's `control.request`; the `enabled` it was answered. */
  const status = async (conn: number) => {
    control!.event('control.request', { conn, request: { id: `r${conn}`, method: 'desktop_status', session_id: 's1', params: {} } });
    await settle();
    const sent = requests.filter(([op, p]) => op === 'control.respond' && p.conn === conn)[0]?.[1];
    return ((sent?.response as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined)?.enabled;
  };
  return { dir, configPath, control, requests, logs, status, loads: () => loads,
    sent: (op: string) => requests.filter(([x]) => x === op).map(([, p]) => p),
    done: () => { void control?.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('--no-attention starts no computer control: the helper gets no control.listen or input.watch', async () => {
  const h = setup({ argv: ['electron', '.', '--no-attention'] });
  try {
    assert.equal(h.control, null);
    await settle();
    assert.deepEqual(h.requests, []);
  } finally { h.done(); }
});

test("each helper hello asks control.listen for this platform's endpoint of the support dir and its token file", async () => {
  const h = setup();
  try {
    assert.notEqual(h.control, null);
    h.control!.helper(true);
    await settle();
    const { path, tokenFile } = controlEndpoint(h.dir, shellPlatform());
    const endpoint = { endpoint: path, token_file: tokenFile };
    assert.deepEqual(h.sent('control.listen'), [endpoint]);
    assert.deepEqual(h.sent('input.watch'), [{ enabled: true }]);
    // A restarted helper has no endpoint (the supervisor does not replay control.listen).
    h.control!.helper(false);
    h.control!.helper(true);
    await settle();
    assert.deepEqual(h.sent('control.listen'), [endpoint, endpoint]);
  } finally { h.done(); }
});

test('the computer_use plug-in is read again only when config.json changes; a config.json that does not load is off', async () => {
  const h = setup();
  try {
    h.control!.helper(true);
    await settle();
    assert.equal(await h.status(1), true);
    assert.equal(await h.status(2), true);
    assert.equal(h.loads(), 1);
    writeFileSync(h.configPath, JSON.stringify({ plugins: { computer_use: false }, mute: true }));
    utimesSync(h.configPath, new Date(), new Date(Date.now() + 5000));
    assert.equal(await h.status(3), false);
    assert.equal(h.loads(), 2);
    writeFileSync(h.configPath, JSON.stringify({ plugins: { computer_use: 'yes' } }));
    utimesSync(h.configPath, new Date(), new Date(Date.now() + 10_000));
    assert.equal(await h.status(4), false);
    writeFileSync(h.configPath, JSON.stringify({ plugins: { computer_use: true } }));
    utimesSync(h.configPath, new Date(), new Date(Date.now() + 15_000));
    assert.equal(await h.status(5), true);
    rmSync(h.configPath);
    assert.equal(await h.status(6), false);
  } finally { h.done(); }
});

test('computerUse.state reads the host OpsContext gives; without one it is not_implemented', async () => {
  const none = computerUseOps({} as OpsContext);
  assert.throws(() => none['computerUse.state']([], {} as never), /not_implemented/);
  const h = setup();
  try {
    const ops = computerUseOps({ computerUse: h.control } as unknown as OpsContext);
    assert.deepEqual(ops['computerUse.state']([], {} as never), { granted: [], active: false });
    assert.equal(ops['computerUse.stop']([], {} as never), null);
  } finally { h.done(); }
});

test('the blacklist file of agentd_state_dir and the shell\'s own processes reach the host: neither is observed', async () => {
  const h = setup();
  try {
    writeFileSync(join(h.dir, 'blacklist.json'), JSON.stringify({ bundle_ids: ['com.example.notes'] }));
    h.control!.helper(true);
    await settle();
    const refused = async (conn: number, params: Record<string, unknown>) => {
      h.control!.event('control.request', { conn, request: { id: `r${conn}`, method: 'desktop_observe', session_id: 's1', params } });
      await settle();
      const sent = h.requests.filter(([op, p]) => op === 'control.respond' && p.conn === conn)[0]?.[1];
      return ((sent?.response as Record<string, unknown> | undefined)?.error as Record<string, unknown> | undefined)?.code;
    };
    assert.equal(await refused(1, { pid: 800, window_id: 77 }), 'blacklisted');
    assert.equal(await refused(2, { pid: process.pid, window_id: 10 }), 'target_ambiguous');
    assert.deepEqual(h.sent('control.observe'), []);
  } finally { h.done(); }
});

test('a launch with computer_use off still gets the endpoint: turning it on and restarting agentd serves without a new host', async () => {
  const h = setup({ config: JSON.stringify({ plugins: { computer_use: false } }) });
  try {
    assert.notEqual(h.control, null);
    h.control!.helper(true);
    await settle();
    const { path, tokenFile } = controlEndpoint(h.dir, shellPlatform());
    assert.deepEqual(h.sent('control.listen'), [{ endpoint: path, token_file: tokenFile }]);
    // No input is watched while it is off.
    assert.deepEqual(h.sent('input.watch'), []);
    assert.equal(await h.status(1), false);
    writeFileSync(h.configPath, JSON.stringify({ plugins: { computer_use: true } }));
    utimesSync(h.configPath, new Date(), new Date(Date.now() + 5000));
    assert.equal(await h.status(2), true);
  } finally { h.done(); }
});
