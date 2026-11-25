// The computer control host (src/main/control/host.ts): its request handling, on a fake
// platform helper whose `control.listen` serves a real Unix socket in a temp dir (as the helper's ControlListen.swift
// does), a fake socket client in agentd's place and a fake clock. Nothing here observes, acts on or reads a real window.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type BlacklistRules, parseBlacklist } from '../src/common/attention.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import type { StreamEvent } from '../src/common/page.ts';
import type { BrowserWindow } from 'electron';
import { controlEndpoint } from '../src/common/agentd.ts';
import type { ShellPlatform } from '../src/common/config.ts';
import { type ControlHost, startControl } from '../src/main/control/host.ts';
import { ControlPanel } from '../src/main/control/panel.ts';
import { computerUseOps } from '../src/main/ops/computer-use.ts';
import type { OpsContext } from '../src/main/ops/context.ts';

// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

/** The control socket is a Unix socket and the host macOS-only so far (README, 电脑控制). */
const UNIX_SOCKET = process.platform === 'win32' ? "the fake helper's control.listen serves a Unix socket, macOS's control transport" : false;

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>, signal?: AbortSignal) => HelperAnswer | Promise<HelperAnswer>);
type Reply = { id: unknown; result?: Record<string, unknown>; error?: { code: string; message: string } };

const OWN = 50;
const APPS = [
  { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit', launched_at: 1000 },
  { pid: 800, name: 'Notes', app_id: 'com.apple.Notes', launched_at: 2000 },
  { pid: 900, name: 'Safari', app_id: 'com.apple.Safari', launched_at: 3000 },
  { pid: OWN, name: 'Endfield', app_id: 'local.agenticcomplex.companion', launched_at: 4000 },
];
const WINDOWS = [
  { window_id: 640, pid: 702, bounds: { x: 0, y: 25, width: 800, height: 600 }, layer: 0, title: 'notes.txt' },
  { window_id: 77, pid: 800, bounds: { x: 40, y: 60, width: 900, height: 700 }, layer: 0, title: 'Groceries' },
  { window_id: 55, pid: 900, bounds: { x: 0, y: 0, width: 1200, height: 800 }, layer: 0, title: 'Bank' },
  { window_id: 10, pid: OWN, bounds: { x: 0, y: 0, width: 300, height: 300 }, layer: 0, title: 'Endfield' },
];
const TARGET = { pid: 702, window_id: 640 };
const CONTROL_OPS = ['control.observe', 'control.act', 'control.read'];

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };

async function setup(o: { helper?: Record<string, Answer>; enabled?: boolean; blacklist?: BlacklistRules; platform?: ShellPlatform } = {}) {
  const support = mkdtempSync(join(tmpdir(), 'cc-'));
  const endpoint = controlEndpoint(support, 'mac');
  let clock = 1_763_539_200_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const state = { enabled: o.enabled ?? true, blacklist: o.blacklist ?? NO_RULES };
  const requests: [string, Record<string, unknown>][] = [];
  const logs: string[] = [];
  let server: Server | null = null;
  let token = '';
  let lastConn = 0;
  const conns = new Map<number, Socket>();
  let observed = 0, ids = 0;
  let host: ControlHost | null = null;
  const helper: Record<string, Answer> = {
    'apps.running': ok({ apps: APPS }),
    'windows.list': (p) => ok({ windows: WINDOWS.filter((w) => p.pid === undefined || w.pid === p.pid) }),
    'permissions.status': ok({ accessibility: 'granted', screenRecording: 'granted', microphone: 'denied', automation: 'notDetermined',
      inputMonitoring: 'granted' }),
    'permissions.request': ok({ state: 'granted' }),
    'input.watch': (p) => ok({ watching: p.enabled === true }),
    'control.observe': (p) => {
      observed += 1;
      return ok({ snapshot_id: `o-t-${observed}`, target: { pid: p.pid, app_id: 'com.apple.TextEdit', window_id: p.window_id,
        bounds: WINDOWS[0].bounds, launched_at: 1000 }, truncated: false, text_truncated: false,
      elements: [
        { element_id: 'e0', role: 'AXWindow', native_role: 'AXWindow', enabled: true, actions: [], ...(p.include_text === true && { title: 'notes.txt' }) },
        { element_id: 'e1', role: 'AXTextField', native_role: 'AXTextField', enabled: true, actions: ['AXPress'],
          ...(p.include_text === true && { title: 'To', value: 'write to a@b.com' }), bounds: { x: 10, y: 10, width: 100, height: 20 } },
      ],
      ...(p.include_image === true && { image: { format: 'png', width: 1, height: 1, data: 'iVBORw0=' } }) });
    },
    'control.act': (p) => ok({ effect: p.action === 'set_value' ? 'confirmed' : 'unverifiable' }),
    'control.read': ok({ value: 'hello', title: 'To' }),
    // ControlListen.swift in miniature: a 0700 directory, a 0600 token, one request per connection without its token.
    'control.listen': async (p) => {
      if (server) return err('already_running');
      const path = p.endpoint as string, tokenFile = p.token_file as string;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      token = randomBytes(32).toString('hex');
      writeFileSync(tokenFile, token, { mode: 0o600 });
      const s = server = createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString('utf8');
          const at = data.indexOf('\n');
          if (at < 0) return;
          const request = JSON.parse(data.slice(0, at)) as Record<string, unknown>;
          if (request.token !== token) {
            socket.end(`${JSON.stringify({ id: request.id ?? null, error: { code: 'unauthorized', message: 'the token is not valid' } })}\n`);
            return;
          }
          delete request.token;
          lastConn += 1;
          conns.set(lastConn, socket);
          host?.event('control.request', { conn: lastConn, request });
        });
        socket.on('error', () => {});
      });
      await new Promise<void>((r) => s.listen(path, r));
      chmodSync(path, 0o600);
      return ok({ endpoint: path });
    },
    'control.respond': (p) => {
      const socket = conns.get(p.conn as number);
      if (!socket) return err('conn_gone');
      conns.delete(p.conn as number);
      socket.end(`${JSON.stringify(p.response)}\n`);
      return ok({ sent: true });
    },
    ...o.helper,
  };
  host = startControl({
    helper: {
      request: async (op, params = {}, signal) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params, signal) : a;
      },
    },
    endpoint,
    enabled: () => state.enabled,
    blacklist: () => state.blacklist,
    ownPids: () => [OWN],
    now: () => clock,
    after: (ms, fn) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    newId: () => `id-${++ids}`,
    log: (line) => logs.push(line),
  }, o.platform ?? 'mac');
  const states: unknown[] = [];
  host.events.subscribe(null, (e: StreamEvent) => states.push(JSON.parse(e.data)));
  await settle();

  /** agentd's client (tool_gateway/computer_use.py): one JSON line with the token, one line back. */
  const ask = (method: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const socket = createConnection(endpoint.path);
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
      socket.on('end', () => { try { resolve(JSON.parse(data) as Reply); } catch (e) { reject(e); } });
      socket.on('error', reject);
      socket.write(`${JSON.stringify({ id: `r-${method}`, method, params, session_id: 's1', token: readFileSync(endpoint.tokenFile, 'utf8'), ...extra })}\n`);
    });
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      due.fn();
      await settle();
    }
    await settle();
  };
  /** The user clicks the panel's grant buttons after a request showed the challenge. */
  const grant = async (...permissions: ('observation' | 'text' | 'image' | 'control')[]) => {
    for (const p of permissions) await host!.grant(p, host!.state.challenge);
    await settle();
  };
  /** A permission_required observe, the user's grants, then a fresh observe's snapshot id. */
  const granted = async (permissions: ('observation' | 'text' | 'image' | 'control')[], params: Record<string, unknown> = TARGET) => {
    const first = await ask('desktop_observe', params);
    assert.equal(first.error?.code, 'permission_required');
    await grant(...permissions);
    const again = await ask('desktop_observe', params);
    assert.ok(again.result, JSON.stringify(again));
    return again.result.snapshot_id as string;
  };
  const sent = (op: string) => requests.filter(([o]) => o === op);
  const cleanup = () => {
    void host!.stop();
    server?.close();
    rmSync(support, { recursive: true, force: true });
  };
  return { host, ask, advance, grant, granted, sent, requests, states, logs, state, endpoint, helper, cleanup,
    get clock() { return clock; } };
}

test('start: control.listen on <support>/run/computer-control.sock and its token beside it, then the input monitor', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    assert.deepEqual(h.sent('control.listen')[0][1], { endpoint: h.endpoint.path, token_file: h.endpoint.tokenFile });
    assert.ok(h.endpoint.path.endsWith('/run/computer-control.sock') && h.endpoint.tokenFile.endsWith('/run/computer-control.token'));
    assert.deepEqual(h.sent('input.watch')[0][1], { enabled: true });
  } finally { h.cleanup(); }
});

test('a request without the token is refused by the endpoint and never reaches the host', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const r = await h.ask('desktop_status', {}, { token: 'nope' });
    assert.equal(r.error?.code, 'unauthorized');
    assert.equal(h.sent('permissions.status').length, 1);
  } finally { h.cleanup(); }
});

test('desktop_status: the switches, the grant of this session and the target app\'s windows without titles', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const r = await h.ask('desktop_status', { target: { bundle_id: 'com.apple.TextEdit' } });
    assert.deepEqual(r.result, { enabled: true, ax_trusted: true, screen_capture: true, session_granted: false, paused: false,
      permissions: [], input_monitor_ready: true, driver: 'endfield-native-ax-v1', actions: ['press', 'set_value', 'type', 'click', 'scroll'],
      windows: [{ window_id: 640, pid: 702, bundle_id: 'com.apple.TextEdit', bounds: WINDOWS[0].bounds }] });
    assert.equal((await h.ask('desktop_status', { target: {} })).error?.code, 'target_required');
    assert.equal((await h.ask('desktop_status', { target: { pid: OWN } })).error?.code, 'target_ambiguous');
  } finally { h.cleanup(); }
});

test('desktop_status while computer use is off: disabled, and the grant is revoked', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation']);
    h.state.enabled = false;
    const r = await h.ask('desktop_status');
    assert.equal(r.result?.enabled, false);
    assert.equal(r.result?.session_granted, false);
    assert.equal(h.host.state.phase, 'disabled');
    h.state.enabled = true;
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'permission_required');
  } finally { h.cleanup(); }
});

test('desktop_status while computer use is off lists no windows of the target', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ enabled: false });
  try {
    const r = await h.ask('desktop_status', { target: { bundle_id: 'com.apple.TextEdit' } });
    assert.equal(r.result?.enabled, false);
    assert.equal('windows' in r.result!, false);
    assert.deepEqual(h.sent('apps.running'), []);
    assert.deepEqual(h.sent('windows.list'), []);
  } finally { h.cleanup(); }
});

test('desktop_status lists no blacklisted app and no window whose title is refused', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ blacklist: parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.Notes'], title_patterns: ['^notes\\.txt$'] }) });
  try {
    assert.equal((await h.ask('desktop_status', { target: { bundle_id: 'com.apple.Notes' } })).error?.code, 'blacklisted');
    assert.equal((await h.ask('desktop_status', { target: { pid: 900 } })).error?.code, 'browser_driver_required');
    assert.deepEqual((await h.ask('desktop_status', { target: TARGET })).result?.windows, []);
  } finally { h.cleanup(); }
});

test('without a grant nothing is observed: permission_required and the panel asks', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const r = await h.ask('desktop_observe', TARGET);
    assert.equal(r.error?.code, 'permission_required');
    assert.deepEqual(h.sent('control.observe'), []);
    assert.equal(h.host.state.phase, 'waitingPermission');
    assert.equal(h.host.state.targetApp, 'TextEdit');
    assert.deepEqual(h.host.state.scopeChips, ['窗口 640', '会话 s1', '10分钟']);
  } finally { h.cleanup(); }
});

test('the grant button without a request asks for one and grants nothing', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.grant('observation');
    assert.equal(h.host.state.action, '请先让会话请求指定窗口，再选择权限。');
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'permission_required');
  } finally { h.cleanup(); }
});

test('a click grants only the challenge the panel showed: a newer request\'s window is shown instead', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'permission_required');
    const shown = h.host.state.challenge;
    // Before the click reaches the main process another session's observe replaces the challenge.
    assert.equal((await h.ask('desktop_observe', { pid: 800, window_id: 77 }, { session_id: 's2' })).error?.code, 'permission_required');
    await h.host.grant('observation', shown);
    await h.advance(0);
    assert.equal((await h.ask('desktop_observe', { pid: 800, window_id: 77 }, { session_id: 's2' })).error?.code, 'permission_required');
    assert.equal(typeof shown, 'string');
    assert.notEqual(h.host.state.challenge, shown);
    assert.deepEqual([h.host.state.phase, h.host.state.targetApp, h.host.state.scopeChips[1]], ['waitingPermission', 'Notes', '会话 s2']);
    await h.host.grant('observation', h.host.state.challenge);
    await h.advance(0);
    assert.ok((await h.ask('desktop_observe', { pid: 800, window_id: 77 }, { session_id: 's2' })).result);
  } finally { h.cleanup(); }
});

test('observe after the grant: the helper reads, text only when granted, redacted', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const id = await h.granted(['observation']);
    assert.equal(id, 'o-t-1');
    assert.deepEqual(h.sent('control.observe')[0][1], { pid: 702, window_id: 640, include_text: false, include_image: false });
    const text = await h.ask('desktop_observe', { ...TARGET, include_text: true });
    assert.equal(text.error?.code, 'permission_required');
    assert.equal(h.sent('control.observe').length, 1);
    await h.grant('text');
    const r = await h.ask('desktop_observe', { ...TARGET, include_text: true });
    const elements = r.result?.elements as Record<string, unknown>[];
    assert.equal(elements[1].value, 'write to [邮箱已遮蔽]');
    assert.equal(r.result?.expires_in_s, 15);
    assert.deepEqual(r.result?.target, { bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640, process_generation: 1000,
      bounds: WINDOWS[0].bounds });
    assert.equal(h.host.state.phase, 'ready');
    assert.deepEqual(h.states.at(-1), { granted: ['observation', 'text'], active: false });
  } finally { h.cleanup(); }
});

test('an image needs its own grant and comes back as PNG', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation']);
    assert.equal((await h.ask('desktop_observe', { ...TARGET, include_image: true })).error?.code, 'permission_required');
    await h.grant('image');
    const r = await h.ask('desktop_observe', { ...TARGET, include_image: true });
    assert.deepEqual(r.result?.image, { mime_type: 'image/png', data: 'iVBORw0=' });
  } finally { h.cleanup(); }
});

test('a system permission that does not apply (Windows) counts as given: the grants go through', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ helper: { 'permissions.status': ok({ accessibility: 'notApplicable', screenRecording: 'notApplicable',
    microphone: 'granted', automation: 'notApplicable', inputMonitoring: 'notApplicable' }) } });
  try {
    await h.granted(['observation', 'image']);
    assert.deepEqual(h.sent('permissions.request'), []);
    const r = await h.ask('desktop_observe', { ...TARGET, include_image: true });
    assert.deepEqual(r.result?.image, { mime_type: 'image/png', data: 'iVBORw0=' });
  } finally { h.cleanup(); }
});

test('act: needs the control grant, sends the checked action, spends one of 5', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    let id = await h.granted(['observation']);
    const refused = await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' });
    assert.equal(refused.error?.code, 'permission_required');
    assert.deepEqual(h.sent('control.act'), []);
    await h.grant('control');
    for (let i = 0; i < 5; i += 1) {
      id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
      const r = await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' });
      assert.match(r.result?.action_id as string, /^id-\d+$/);
      assert.deepEqual(r.result, { action_id: r.result?.action_id, effect: 'unverifiable', verified: false, requires_fresh_observation: true,
        target: { bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640, process_generation: 1000, bounds: WINDOWS[0].bounds } });
      await h.advance(300);
    }
    assert.deepEqual(h.sent('control.act')[0][1], { snapshot_id: 'o-t-2', action: 'press', element_id: 'e1' });
    id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'permission_required');
    assert.equal(h.sent('control.act').length, 5);
  } finally { h.cleanup(); }
});

test('act: an old snapshot is stale after an action, and acts are 250 ms apart', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.ok((await h.ask('desktop_act', { snapshot_id: id, action: 'click', x: 10, y: 10 })).result);
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'click', x: 10, y: 10 })).error?.code, 'stale_snapshot');
    const next = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: next, action: 'click', x: 10, y: 10 })).error?.code, 'action_cooldown');
    assert.equal(h.sent('control.act').length, 1);
  } finally { h.cleanup(); }
});

test('act: a text write needs the text grant and uses up the control grant', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    let id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'set_value', element_id: 'e1', text: 'hi' })).error?.code,
      'permission_required');
    await h.grant('text');
    id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    const r = await h.ask('desktop_act', { snapshot_id: id, action: 'set_value', element_id: 'e1', text: 'hi' });
    assert.equal(r.result?.effect, 'confirmed');
    assert.equal(r.result?.verified, true);
    await h.advance(300);
    id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'permission_required');
    assert.equal(h.sent('control.act').length, 1);
  } finally { h.cleanup(); }
});

test('act: bad points and elements are refused before the helper', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    let id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'click', x: 801, y: 1 })).error?.code, 'invalid_point');
    id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e7' })).error?.code, 'element_required');
    assert.deepEqual(h.sent('control.act'), []);
    assert.equal(h.host.state.phase, 'failed');
  } finally { h.cleanup(); }
});

test('Windows: no click or scroll is advertised, and one is refused before it spends the snapshot or the budget', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ platform: 'windows' });
  try {
    assert.deepEqual((await h.ask('desktop_status')).result?.actions, ['press', 'set_value', 'type']);
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    for (const action of ['click', 'scroll']) {
      assert.equal((await h.ask('desktop_act', { snapshot_id: id, action, x: 10, y: 10, delta_y: 5 })).error?.code, 'unsupported');
    }
    assert.deepEqual(h.sent('control.act'), []);
    assert.ok((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).result);
    for (let i = 0; i < 4; i += 1) {
      await h.advance(300);
      const next = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
      assert.ok((await h.ask('desktop_act', { snapshot_id: next, action: 'press', element_id: 'e1' })).result);
    }
  } finally { h.cleanup(); }
});

test('the control grant runs out after 120 s and the task grant after 600 s', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    await h.advance(121_000);
    assert.equal(h.host.state.phase, 'waitingPermission');
    assert.equal(h.host.state.action, '本次操作授权已用完或已过期，需要重新允许');
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'permission_required');
    await h.advance(480_000);
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'permission_required');
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('a snapshot older than 15 s is stale', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    await h.advance(15_000);
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'stale_snapshot');
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('blacklisted apps and window titles, browsers and this shell are never observed', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ blacklist: parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.Notes'], title_patterns: ['^notes\\.txt$'] }) });
  try {
    assert.equal((await h.ask('desktop_observe', { pid: 800, window_id: 77 })).error?.code, 'blacklisted');
    assert.equal((await h.ask('desktop_observe', { pid: 900, window_id: 55 })).error?.code, 'browser_driver_required');
    assert.equal((await h.ask('desktop_observe', { pid: OWN, window_id: 10 })).error?.code, 'target_ambiguous');
    assert.equal((await h.ask('desktop_observe', { bundle_id: 'local.agenticcomplex.companion' })).error?.code, 'target_ambiguous');
    h.state.blacklist = NO_RULES;
    await h.granted(['observation']);
    h.state.blacklist = parseBlacklist({ mode: 'deny', title_patterns: ['^notes\\.txt$'] });
    const r = await h.ask('desktop_observe', TARGET);
    assert.equal(r.error?.code, 'blacklisted');
    assert.equal(r.error?.message, '此窗口标题被排除');
    assert.equal(h.sent('control.observe').length, 1);
  } finally { h.cleanup(); }
});

test('a window whose title is not readable is not observed while the blacklist has title rules', { skip: UNIX_SOCKET }, async () => {
  // windows.list's CG titles are null without Screen Recording (C12 §7.2); the AX observation would still read the window.
  const untitled = (p: Record<string, unknown>) => ok({ windows: WINDOWS.filter((w) => w.pid === p.pid).map((w) => ({ ...w, title: null })) });
  const h = await setup({ helper: { 'windows.list': untitled } });
  try {
    await h.granted(['observation', 'text']);
    h.state.blacklist = parseBlacklist({ mode: 'deny', title_patterns: ['^notes\\.txt$'] });
    const r = await h.ask('desktop_observe', { ...TARGET, include_text: true });
    assert.equal(r.error?.code, 'blacklisted');
    assert.equal(h.sent('control.observe').length, 1);
    h.state.blacklist = parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.Notes'] });
    assert.ok((await h.ask('desktop_observe', TARGET)).result);
  } finally { h.cleanup(); }
});

test('a window title blacklisted after the observation is neither acted on nor read', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'text', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    h.state.blacklist = parseBlacklist({ mode: 'deny', title_patterns: ['^notes\\.txt$'] });
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'blacklisted');
    assert.equal((await h.ask('desktop_verify', { snapshot_id: id, element_id: 'e1', expected_value: 'hello' })).error?.code, 'blacklisted');
    assert.deepEqual([h.sent('control.act'), h.sent('control.read')], [[], []]);
  } finally { h.cleanup(); }
});

test('an app blacklisted after the grant is not acted on', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    h.state.blacklist = parseBlacklist({ mode: 'deny', app_names: ['TextEdit'] });
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'blacklisted');
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('a moved window is target_changed and not acted on', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    h.helper['windows.list'] = ok({ windows: [{ ...WINDOWS[0], bounds: { ...WINDOWS[0].bounds, x: 5 } }] });
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'target_changed');
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('Stop revokes at once: an act waiting on the helper sends nothing after it', { skip: UNIX_SOCKET }, async () => {
  let release: () => void = () => {};
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    h.helper['windows.list'] = (p) => new Promise((resolve) => {
      release = () => resolve(ok({ windows: WINDOWS.filter((w) => w.pid === p.pid) }));
    });
    const before = h.sent('windows.list').length;
    const acting = h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' });
    for (let i = 0; i < 50 && h.sent('windows.list').length === before; i += 1) await new Promise((r) => setTimeout(r, 5));
    void h.host.stopControl();
    release();
    assert.equal((await acting).error?.code, 'stopped');
    assert.deepEqual(h.sent('control.act'), []);
    await h.advance(0);
    assert.equal(h.host.state.phase, 'paused');
    assert.equal(h.host.state.action, '已停止；需要重新授权才可继续');
    assert.deepEqual(h.states.at(-1), { granted: [], active: false });
  } finally { h.cleanup(); }
});

for (const [name, interrupt] of [
  ['Stop', (h: Awaited<ReturnType<typeof setup>>) => void h.host.stopControl()],
  ['the user\'s input', (h: Awaited<ReturnType<typeof setup>>) => h.host.event('input.activity', { kind: 'key' })],
  ['desktop_cancel', (h: Awaited<ReturnType<typeof setup>>) => void h.ask('desktop_cancel')],
  ['revoking a permission', (h: Awaited<ReturnType<typeof setup>>) => void h.host.grant('observation', h.host.state.challenge)],
] as const) {
  test(`${name} while control.act is at the helper cancels it there, and its late success is not one`, { skip: UNIX_SOCKET }, async () => {
    const h = await setup();
    let signal: AbortSignal | undefined, release: () => void = () => {};
    try {
      await h.granted(['observation', 'control']);
      const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
      h.helper['control.act'] = (_p, s) => {
        signal = s;
        return new Promise((resolve) => { release = () => resolve(ok({ effect: 'unverifiable' })); });
      };
      const acting = h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' });
      for (let i = 0; i < 50 && h.sent('control.act').length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
      interrupt(h);
      await settle();
      release();
      assert.equal((await acting).error?.code, 'stopped');
      assert.equal(signal?.aborted, true);
    } finally {
      release();
      h.cleanup();
    }
  });
}

test('revoking a granted permission from the panel takes effect for the next request', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    await h.grant('control');
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal(h.host.state.permissions.control, 'off');
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'permission_required');
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('the user\'s own input pauses the task; acts are user_paused until 继续, then need a fresh observation', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    h.host.event('input.activity', { kind: 'key' });
    await h.advance(0);
    assert.equal(h.host.state.phase, 'paused');
    assert.equal(h.host.state.canResume, true);
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'user_paused');
    await h.host.resume();
    assert.equal(h.host.state.phase, 'ready');
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'stale_snapshot');
    const next = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.ok((await h.ask('desktop_act', { snapshot_id: next, action: 'press', element_id: 'e1' })).result);
  } finally { h.cleanup(); }
});

test('a second 继续 right after the first keeps the grant it resumed', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    h.host.event('input.activity', { kind: 'key' });
    await h.advance(0);
    const phases: string[] = [];
    h.host.onPanel = (s) => phases.push(s.phase);
    await Promise.all([h.host.resume(), h.host.resume()]);
    assert.deepEqual(phases, ['ready']);
    assert.deepEqual(h.states.at(-1), { granted: ['observation', 'control'], active: false });
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.ok((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).result);
  } finally { h.cleanup(); }
});

test('without the input monitor nothing is acted on', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ helper: { 'input.watch': err('permission_denied') } });
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'input_monitor_unavailable');
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('another session is desktop_busy while one holds the grant', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation']);
    const r = await h.ask('desktop_observe', TARGET, { session_id: 's2' });
    assert.equal(r.error?.code, 'desktop_busy');
  } finally { h.cleanup(); }
});

test('verify: reads the element and compares, after the text grant', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation']);
    let id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.deepEqual((await h.ask('desktop_verify', { snapshot_id: id, element_id: 'e1' })).result,
      { effect: 'unknown', verified: false, reason: '需要明确预期值或标题' });
    assert.equal((await h.ask('desktop_verify', { snapshot_id: id, element_id: 'e1', expected_value: 'hello' })).error?.code,
      'permission_required');
    await h.grant('text');
    id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.deepEqual((await h.ask('desktop_verify', { snapshot_id: id, element_id: 'e1', expected_value: 'hello' })).result,
      { effect: 'confirmed', verified: true });
    assert.equal(h.host.state.phase, 'completed');
    assert.deepEqual((await h.ask('desktop_verify', { snapshot_id: id, element_id: 'e1', expected_title: 'From' })).result,
      { effect: 'unsatisfied', verified: false });
    assert.equal((await h.ask('desktop_verify', { snapshot_id: id, element_id: 'e9', expected_value: 'x' })).error?.code, 'element_required');
    assert.deepEqual(h.sent('control.read')[0][1], { snapshot_id: id, element_id: 'e1' });
  } finally { h.cleanup(); }
});

test('the helper not running: native_error, and the panel says the tool did not finish', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    h.helper['apps.running'] = err('helper_exited');
    const r = await h.ask('desktop_observe', TARGET);
    assert.deepEqual(r.error, { code: 'native_error', message: '桌面控制组件执行失败', retryable: false });
    assert.equal(h.host.state.phase, 'failed');
    assert.ok(h.logs.some((l) => l.includes('apps.running failed code=helper_exited')));
  } finally { h.cleanup(); }
});

test('a helper timeout in an act is native_error and the action is not retried', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ helper: { 'control.act': err('helper_timeout') } });
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'native_error');
    assert.equal(h.sent('control.act').length, 1);
  } finally { h.cleanup(); }
});

test('helper failures come back as the control error codes', { skip: UNIX_SOCKET }, async () => {
  const h = await setup({ helper: { 'control.observe': err('permission_denied') } });
  try {
    await h.ask('desktop_observe', TARGET);
    await h.grant('observation');
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'ax_permission_required');
  } finally { h.cleanup(); }
});

test('wait_for_permission: the observe waits for the grant, then answers', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const waiting = h.ask('desktop_observe', TARGET, { wait_for_permission: true });
    for (let i = 0; i < 50 && h.host.state.phase !== 'waitingPermission'; i += 1) await new Promise((r) => setTimeout(r, 5));
    await h.grant('observation');
    const r = await waiting;
    assert.equal(r.result?.snapshot_id, 'o-t-1');
  } finally { h.cleanup(); }
});

test('wait_for_permission times out after 180 s', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const waiting = h.ask('desktop_observe', TARGET, { wait_for_permission: true });
    for (let i = 0; i < 50 && h.host.state.phase !== 'waitingPermission'; i += 1) await new Promise((r) => setTimeout(r, 5));
    await h.advance(179_000);
    await h.advance(1_000);
    assert.deepEqual((await waiting).error, { code: 'permission_timeout', message: '等待授权超时；请重新发起任务' });
    assert.deepEqual(h.sent('control.observe'), []);
  } finally { h.cleanup(); }
});

test('wait_for_resume: a paused act is never replayed; after 继续 it asks for a fresh observation', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    await h.host.userIntervened();
    const waiting = h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' }, { wait_for_resume: true });
    await new Promise((r) => setTimeout(r, 30));
    await h.host.resume();
    assert.deepEqual((await waiting).error, { code: 'stale_snapshot', message: '已继续；请重新观察窗口后再决定操作' });
    assert.deepEqual(h.sent('control.act'), []);
  } finally { h.cleanup(); }
});

test('desktop_cancel stops the session at once; another session cannot cancel it', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation']);
    assert.equal((await h.ask('desktop_cancel', {}, { session_id: 's2' })).error?.code, 'session_not_granted');
    assert.deepEqual((await h.ask('desktop_cancel')).result, { cancelled: true, cleanup_pending: true });
    await h.advance(0);
    assert.equal(h.host.state.action, '任务已取消');
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'permission_required');
  } finally { h.cleanup(); }
});

test('desktop_release gives the grant back without leaving it stopped', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation']);
    assert.deepEqual((await h.ask('desktop_release', {}, { session_id: 's2' })).result, { released: false });
    assert.deepEqual((await h.ask('desktop_release')).result, { released: true });
    assert.equal(h.host.state.phase, 'ready');
    assert.equal((await h.ask('desktop_status')).result?.session_granted, false);
  } finally { h.cleanup(); }
});

test('bad requests: unknown methods, missing sessions, computer use off', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    assert.equal((await h.ask('desktop_drag')).error?.code, 'unknown_method');
    assert.equal((await h.ask('desktop_status', {}, { session_id: '' })).error?.code, 'invalid_request');
    h.state.enabled = false;
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'disabled');
    assert.deepEqual(h.sent('apps.running'), []);
  } finally { h.cleanup(); }
});

test('a new helper is asked for the endpoint again, and old snapshots are dropped', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    await h.granted(['observation', 'control']);
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    h.host.helper(false);
    h.host.helper(true);
    await h.advance(0);
    assert.equal(h.sent('control.listen').length, 2);
    assert.equal((await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' })).error?.code, 'stale_snapshot');
  } finally { h.cleanup(); }
});

test('a request of a helper that went ends without an answer, and never answers the new helper\'s same conn', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const request = { id: 'old', method: 'desktop_observe', session_id: 's1', params: TARGET, wait_for_permission: true };
    let ended = false;
    void h.host.serve(1, request).then(() => { ended = true; });
    for (let i = 0; i < 50 && h.host.state.phase !== 'waitingPermission'; i += 1) await new Promise((r) => setTimeout(r, 5));
    h.host.helper(false);
    h.host.helper(true);
    await h.advance(0);
    assert.equal(ended, true);
    await h.grant('observation');
    await h.advance(0);
    assert.deepEqual(h.sent('control.respond'), []);
  } finally { h.cleanup(); }
});

test('computerUse.state, computerUse.stop and computerUse.onState over the host', { skip: UNIX_SOCKET }, async () => {
  assert.throws(() => computerUseOps({} as OpsContext)['computerUse.state']([], {} as never), /not_implemented/);
  const h = await setup();
  try {
    const ops = computerUseOps({ computerUse: h.host } as unknown as OpsContext);
    assert.equal(ops['computerUse.grant'], undefined);
    await h.granted(['observation']);
    assert.deepEqual(ops['computerUse.state']([], {} as never), { granted: ['observation'], active: false });
    const pushed: StreamEvent[] = [];
    const page = { generation: 1, subscribe: (_g: number, _op: string, _id: number, source: { subscribe: (a: null, f: (e: StreamEvent) => void, r: () => void) => unknown }) => {
      source.subscribe(null, (e) => pushed.push(e), () => {});
    } };
    ops['computerUse.onState']([7], page as never);
    assert.equal(ops['computerUse.stop']([], {} as never), null);
    await h.advance(0);
    assert.deepEqual(pushed.map((e) => [e.event, JSON.parse(e.data)]), [['state', { active: false, granted: [] }]]);
  } finally {
    h.cleanup();
  }
});

test('the panel: waiting for a choice, the page grants, agentd acts, the page stops', { skip: UNIX_SOCKET }, async () => {
  const h = await setup();
  try {
    const shown: string[] = [];
    const win = {
      webContents: { id: 9, isDestroyed: () => false, send: () => {}, on: () => {} }, on: () => {}, loadURL: async () => {},
      showInactive: () => shown.push('show'), hide: () => shown.push('hide'), setBounds: () => {}, destroy: () => {},
    };
    let panelOps: ReadonlyMap<string, (args: unknown[], page: never) => unknown> = new Map();
    const panel = new ControlPanel({
      host: h.host, url: 'agentic-complex-ui://app/stack.html#/computer', makeWindow: () => win as unknown as BrowserWindow,
      toDip: (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }), body: () => null,
      screens: () => [{ id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 0, w: 1440, h: 875 } }],
      mouse: () => ({ x: 0, y: 0 }), webDesktop: () => false,
      register: (_c, _p, m) => { panelOps = m; }, unregister: () => {},
      baseOps: new Map(Object.entries(computerUseOps({ computerUse: h.host } as unknown as OpsContext))),
    });
    const raises: boolean[] = [];
    h.host.onPanel = (s, raise) => {
      raises.push(raise);
      panel.present(s, raise);
    };
    panel.start();
    const click = (op: string, ...args: unknown[]) => panelOps.get(op)!(args, {} as never);

    const first = await h.ask('desktop_observe', TARGET);
    assert.equal(first.error?.code, 'permission_required');
    assert.deepEqual([panel.isShown, h.host.state.phase, h.host.state.showsPermissionChoices], [true, 'waitingPermission', true]);
    click('computerUse.grant', ['observation', 'control'], h.host.state.challenge);
    // The click marks the choice pending in place, never raising the panel (ComputerUsePanelModel.beginGrant).
    assert.deepEqual(h.host.state.pendingGrants, ['observation', 'control']);
    assert.deepEqual(raises.slice(-2), [false, false]);
    await h.advance(0);
    assert.deepEqual(h.states.at(-1), { granted: ['observation', 'control'], active: false });
    const id = (await h.ask('desktop_observe', TARGET)).result!.snapshot_id as string;
    const act = await h.ask('desktop_act', { snapshot_id: id, action: 'press', element_id: 'e1' });
    assert.equal(act.result?.effect, 'unverifiable');
    assert.equal(h.host.state.phase, 'verifying');

    click('computerUse.stop');
    await h.advance(0);
    assert.deepEqual([h.host.state.phase, h.host.state.action, panel.isShown], ['paused', '已停止；需要重新授权才可继续', true]);
    const again = await h.ask('desktop_observe', TARGET);
    assert.equal(again.error?.code, 'permission_required');
    click('computerUse.dismiss');
    await h.advance(0);
    assert.deepEqual([h.host.state.action, panel.isShown, shown.at(-1)], ['已收起并停止电脑操作', false, 'hide']);
  } finally {
    h.cleanup();
  }
});

test('the host publishes display text, and a release updates the panel without raising it', { skip: UNIX_SOCKET }, async () => {
  const name = `Text   ${'A'.repeat(60)}`;
  const h = await setup({ helper: { 'apps.running': ok({ apps: [{ ...APPS[0], name }] }) } });
  try {
    const raises: boolean[] = [];
    h.host.onPanel = (_s, raise) => raises.push(raise);
    assert.equal((await h.ask('desktop_observe', TARGET)).error?.code, 'permission_required');
    // ComputerUsePanelState.forDisplay: whitespace runs as one space, 48 code points and an ellipsis.
    assert.equal(h.host.state.targetApp, `Text ${'A'.repeat(43)}…`);
    assert.equal(raises.at(-1), true);
    assert.deepEqual((await h.ask('desktop_release')).result, { released: false });
    assert.deepEqual([h.host.state.phase, raises.at(-1)], ['ready', false]);
  } finally {
    h.cleanup();
  }
});
