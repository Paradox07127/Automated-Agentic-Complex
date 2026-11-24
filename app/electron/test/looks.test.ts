// Switching the character (over C3 and agentd's switch routes), her appearance, outfit layers, action switches and mod
// settings against an in-test avatar on a temp socket, and the files they remember, read and written.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import { type C3Message, decodeLine } from '../src/common/c3.ts';
import { storedModSettings, storedSwitches } from '../src/common/looks.ts';
import { PageSession } from '../src/common/page.ts';
import { agentdSwitchPorts, CharacterSwitch, type SwitchPorts } from '../src/common/switch.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { avatarOps } from '../src/main/ops/avatar.ts';
import { characterOps } from '../src/main/ops/character.ts';
import type { OpsContext } from '../src/main/ops/index.ts';
import { readState } from '../src/main/placement/store.ts';
import { PreviewController } from '../src/main/preview/controller.ts';
import type { PreviewSelection } from '../src/main/preview/session.ts';
import { HostLink, type LinkEvent } from '../src/main/renderer/link.ts';
import { AvatarLooks, linkSwitchPorts, type LooksOptions, rememberedLooks } from '../src/main/renderer/looks.ts';
import { rendererArguments } from '../src/main/renderer/supervisor.ts';
import { loadConfig } from '../src/main/config.ts';
import { PushSource } from '../src/common/push.ts';

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.02);
  }
  return ok();
}

const APPEARANCES = [{ id: 'default', name: '默认' }, { id: 'summer', name: '夏装', kind: 'imported' }];
const LAYERS = [{ id: 'coat', name: '外套' }, { id: 'hat', name: '帽子' }];
/** The link listens on a Unix socket here, the macOS transport; on Windows it connects to the renderer's named pipe. */
const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;

/** The mod switches of each appearance the fake draws, with their defaults. */
const MOD_TABLES: Record<string, Record<string, number>> = { default: { coat: 0 }, summer: { coat: 0, color: 0 } };

/** An avatar on the link's socket. `mac` answers as the Metal renderer does; `windows` as efw: no appearances, no
 *  layers, and no reply to `set_character` or `set_appearance`. Types in `ignore` get no reply. */
class FakeAvatar {
  readonly socket: Socket;
  readonly got: C3Message[] = [];
  private buffer = '';
  character: string;
  appearance = 'default';
  hidden: string[] = [];
  switches: Record<string, boolean> = { wave: true, idle: true };
  readonly ignore = new Set<string>();
  readonly mode: 'mac' | 'windows';

  constructor(path: string, mode: 'mac' | 'windows', character = 'aster', hello: Record<string, unknown> = {}) {
    this.mode = mode;
    this.character = character;
    this.socket = connect(path);
    this.socket.on('error', () => {});
    this.socket.on('data', (d) => {
      this.buffer += d.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const m = decodeLine(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        if (m) this.onMessage(m);
      }
    });
    this.send(mode === 'mac'
      ? { type: 'hello', role: 'avatar', pid: 99, protocol: 1, character, capabilities: ['ack', 'actions', 'layers', 'mod_settings'],
        ...this.looks(), ...hello }
      : { type: 'hello', role: 'avatar', pid: 99, protocol: 1, character, capabilities: ['heartbeat', 'render_progress', 'ack', 'actions', 'action_loop', 'pipeline'],
        build: { git: 'unknown', renderer: 'd3d11' }, ...hello });
  }

  private looks(): Record<string, unknown> {
    return { appearance: this.appearance, appearances: APPEARANCES, layers: LAYERS, hidden_layers: this.hidden };
  }

  private onMessage(m: C3Message): void {
    this.got.push(m);
    if (this.ignore.has(m.type)) return;
    const windows = this.mode === 'windows';
    if (m.type === 'set_character' && !windows) {
      if (m.id === 'cedar') return this.send({ type: 'character_change_failed', id: m.id, reason: 'unknown_character' });
      this.character = m.id as string;
      this.appearance = typeof m.appearance === 'string' ? m.appearance : 'default';
      this.hidden = Array.isArray(m.hidden_layers) ? m.hidden_layers as string[] : [];
      this.send({ type: 'character_changed', id: m.id, ms: 100, ...this.looks() });
    } else if (m.type === 'set_appearance' && !windows) {
      if (!APPEARANCES.some((a) => a.id === m.id)) return this.send({ type: 'appearance_change_failed', id: m.id, reason: 'unknown_appearance' });
      this.appearance = m.id as string;
      this.send({ type: 'appearance_changed', id: m.id });
    } else if (m.type === 'set_layers' && !windows) {
      const hidden = m.hidden as string[];
      if (!hidden.every((h) => LAYERS.some((l) => l.id === h))) return this.send({ type: 'layers_change_failed', hidden, reason: 'unknown_layer' });
      this.hidden = hidden;
      this.send({ type: 'layers_changed', hidden });
    } else if (m.type === 'set_mod_settings' && !windows) {
      const table = MOD_TABLES[m.appearance as string];
      if (!table) return this.send({ type: 'ack', req: m.req, ok: false, error: 'invalid' });
      this.send({ type: 'ack', req: m.req, ok: true });
      const values = m.values as Record<string, number>;
      const drawn = Object.fromEntries(Object.entries(table).map(([k, d]) => [k, values[k] ?? d]));
      const adjusted = Object.keys(table).filter((k) => !(k in values)).map((id) => ({ id, reason: 'defaulted' }));
      this.send({ type: 'mod_settings', req: m.req, character: m.character, appearance: m.appearance, values: drawn,
        ...(adjusted.length > 0 ? { adjusted } : {}) });
    } else if (m.type === 'get_actions') {
      this.sendActions();
    } else if (m.type === 'set_action_switches') {
      this.switches = { ...this.switches, ...(m.switches as Record<string, boolean>) };
      this.send({ type: 'action_switches', character: m.character, switches: this.switches, adjusted: [] });
    } else if (typeof m.req === 'number') {
      this.send({ type: 'ack', req: m.req, ok: true });
    }
  }

  sendActions(): void {
    this.send({ type: 'actions', character: this.character, switches: this.switches,
      actions: [{ id: 'wave', name: '挥手', section: 'react', duration: 2, trigger: '点击', required_reason: null, missing: null },
        { id: 'idle', name: '站', section: 'idle', duration: null, trigger: '自动', required_reason: null, missing: null }] });
  }

  send(m: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify({ v: 1, ...m })}\n`);
  }

  sent(type: string): C3Message[] { return this.got.filter((m) => m.type === type); }
}

/** agentd's switch routes as a fake: `prepare` gives `s1`, `commit` and `abort` succeed. */
function fakeAgentd() {
  const calls: string[] = [];
  let character = 'aster';
  const reply = (status: number, body: unknown) => ({ status, body: Buffer.from(JSON.stringify(body)) });
  const request = async (method: string, path: string, json?: unknown) => {
    const id = (json as Record<string, string> | undefined)?.id ?? (json as Record<string, string> | undefined)?.switch_id;
    calls.push(`${method} ${path}${id ? ` ${id}` : ''}`);
    if (path === '/state') return reply(200, { character });
    if (path === '/character/prepare') return reply(200, { switch_id: `s-${id}` });
    if (path === '/character/commit') {
      character = id!.slice(2);
      return reply(200, { ok: true });
    }
    if (path === '/character/abort') return reply(200, { ok: true });
    if (path === '/character') {
      character = id!;
      return reply(200, { changed: true });
    }
    return reply(404, { error: 'not_found' });
  };
  return { calls, request, character: () => character };
}

/** A support dir and config.json, the host link at 1/100 of C3's timeouts, her looks, the switch and the bridge ops. */
async function stack(o: { state?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'l-')), support = join(dir, 's');
  mkdirSync(support);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ mute: false, ...o.config }));
  if (o.state) writeFileSync(join(support, 'state.json'), JSON.stringify(o.state));
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const remembered = rememberedLooks(support, configPath);
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log, remembered, timeScale: 0.01 });
  const looks = new AvatarLooks({ link, supportDir: support, configPath, log });
  looks.start();
  const agentd = fakeAgentd();
  const restarts: string[] = [];
  const switcher = new CharacterSwitch(linkSwitchPorts({ link, supportDir: support, agentd: agentd.request, agentdRunning: () => true,
    restartAvatar: (id) => restarts.push(id), renderable: () => true, log }));
  link.on((e) => { if (e.kind === 'character') switcher.avatar(e.event); });
  await link.start();
  const ctx = { surface: 'main', routes, config: { path: configPath, supportDir: support, devResources: null }, agentd: null,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }) },
    avatar: link, looks, switcher, library: { launched: 'aster', catalog: null }, log } as unknown as OpsContext;
  const ops = new Map([...Object.entries(avatarOps(ctx)), ...Object.entries(characterOps(ctx))]), page = new PageSession(() => {});
  const call = (op: string, ...args: unknown[]) => handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
  const avatars: FakeAvatar[] = [];
  const avatar = async (mode: 'mac' | 'windows', character = 'aster') => {
    const a = new FakeAvatar(link.path, mode, character);
    avatars.push(a);
    assert.ok(await until(2, () => switcher.current === character && a.got.length > 0), lines.join('\n'));
    return a;
  };
  const done = () => {
    for (const a of avatars) a.socket.destroy();
    link.stop();
    looks.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, support, configPath, lines, link, looks, remembered, switcher, agentd, restarts, call, avatar, done,
    config: () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> };
}

test('character.switchTo: prepare, one set_character with her remembered appearance, layers and mod settings, commit; then remembered', { skip: UNIX_LINK }, async () => {
  const s = await stack({ state: { last_character: 'aster', last_appearance: { birch: 'summer' }, hidden_layers: { birch: ['hat'] },
    window_scale: { aster: 1.25 } }, config: { mod_settings: { birch: { summer: { coat: 1 } } } } });
  try {
    const a = await s.avatar('mac');
    assert.deepEqual(await s.call('character.switchTo', 'birch'), { ok: true, value: { ok: true } });
    assert.deepEqual(s.agentd.calls, ['POST /character/prepare birch', 'POST /character/commit s-birch']);
    assert.deepEqual(a.sent('set_character'), [{ v: 1, type: 'set_character', id: 'birch', appearance: 'summer', hidden_layers: ['hat'],
      mod_settings: { summer: { coat: 1 } } }]);
    assert.equal(s.link.currentCharacter, 'birch');
    assert.equal(s.link.currentAppearance, 'summer');
    assert.deepEqual(readState(s.support), { last_character: 'birch', last_appearance: { birch: 'summer', aster: 'default' },
      hidden_layers: { birch: ['hat'], aster: [] }, window_scale: { aster: 1.25 } }, 'her hello and reply look is remembered too');
    assert.deepEqual(s.restarts, [], 'a renderer that switches in place is not restarted');
    assert.deepEqual(await s.call('character.switchTo', ''), { ok: false, error: { code: 'invalid_args', detail: 'character id' } });
  } finally {
    s.done();
  }
});

test("a switch the renderer refuses aborts agentd's prepared switch and keeps the character; before a hello there is no avatar", { skip: UNIX_LINK }, async () => {
  const s = await stack({ state: { last_character: 'aster' } });
  try {
    assert.deepEqual(await s.call('character.switchTo', 'birch'), { ok: false, error: { code: 'unavailable', detail: '角色还没连上' } });
    await s.avatar('mac');
    assert.deepEqual(await s.call('character.switchTo', 'cedar'), { ok: true, value: { ok: false, stage: 'avatar', reason: 'unknown_character' } });
    assert.deepEqual(s.agentd.calls, ['POST /character/prepare cedar', 'POST /character/abort s-cedar']);
    assert.equal(s.switcher.current, 'aster');
    assert.equal(readState(s.support).last_character, 'aster');
  } finally {
    s.done();
  }
});

test('the Windows renderer answers no set_character: after rule 14\'s 11 s it fails as timeout and agentd\'s switch is aborted; a late character_changed is switched back', { skip: UNIX_LINK }, async () => {
  const s = await stack({ state: { last_character: 'aster' } });
  try {
    const a = await s.avatar('windows');
    assert.deepEqual(a.got[0]!.capabilities, ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings']);
    const began = Date.now();
    assert.deepEqual(await s.call('character.switchTo', 'birch'), { ok: true, value: { ok: false, stage: 'avatar', reason: 'timeout' } });
    assert.ok(Date.now() - began >= 100, `${Date.now() - began} ms: the link waits 11 s, scaled by 0.01`);
    assert.deepEqual(s.agentd.calls, ['POST /character/prepare birch', 'POST /character/abort s-birch']);
    assert.equal(s.link.currentCharacter, 'aster');
    assert.equal(readState(s.support).last_character, 'aster');
    assert.ok(s.lines.includes('set_character id=birch timed out'), s.lines.join('\n'));
    // Rule 16: no appearance list from efw, so there is nothing to switch to; layers need both hellos to list `layers`.
    assert.deepEqual(await s.call('avatar.setAppearance', 'default'), { ok: false, error: { code: 'failed', detail: '角色没有这个外观' } });
    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: [], show: [] }), { ok: false, error: { code: 'failed', detail: '这个角色没有可以隐藏的层' } });
    assert.deepEqual(await s.call('avatar.modSettings.set', { character: 'aster', appearance: 'default', values: {} }),
      { ok: false, error: { code: 'failed', detail: '这个版本的角色不支持 mod 设置' } });

    // Rule 14: a character_changed of the timed-out request is logged, and the switch puts her back on the current character.
    a.send({ type: 'character_changed', id: 'birch', ms: 9000 });
    assert.ok(await until(2, () => a.sent('set_character').length === 2), s.lines.join('\n'));
    assert.deepEqual(a.sent('set_character').map((m) => m.id), ['birch', 'aster']);
    assert.ok(s.lines.some((l) => l.startsWith('character_changed id=birch reason= came after the timeout')), s.lines.join('\n'));
  } finally {
    s.done();
  }
});

test('avatar.setAppearance and avatar.setLayers wait for the reply and remember it; unknown ids, bad arguments and a silent renderer fail', { skip: UNIX_LINK }, async () => {
  const s = await stack();
  try {
    const a = await s.avatar('mac');
    assert.deepEqual(await s.call('avatar.setAppearance', 'summer'), { ok: true, value: null });
    assert.deepEqual((readState(s.support).last_appearance as Record<string, string>).aster, 'summer');
    assert.deepEqual(await s.call('avatar.setAppearance', 'summer'), { ok: true, value: null }, 'already worn: nothing is sent');
    assert.equal(a.sent('set_appearance').length, 1);
    assert.deepEqual(await s.call('avatar.setAppearance', 'winter'), { ok: false, error: { code: 'failed', detail: '角色没有这个外观' } });
    assert.deepEqual(await s.call('avatar.setAppearance', ''), { ok: false, error: { code: 'invalid_args', detail: 'appearance id' } });

    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: ['coat'], show: [] }), { ok: true, value: null });
    assert.deepEqual(a.sent('set_layers').at(-1), { v: 1, type: 'set_layers', hidden: ['coat'] });
    assert.deepEqual((readState(s.support).hidden_layers as Record<string, string[]>).aster, ['coat']);
    // A change keeps the layers it does not name, such as another appearance's hidden coat.
    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: ['hat'], show: [] }), { ok: true, value: null });
    assert.deepEqual(a.sent('set_layers').at(-1), { v: 1, type: 'set_layers', hidden: ['coat', 'hat'] });
    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: [], show: ['hat'] }), { ok: true, value: null });
    assert.deepEqual(a.sent('set_layers').at(-1), { v: 1, type: 'set_layers', hidden: ['coat'] });
    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: ['scarf'], show: [] }), { ok: false, error: { code: 'failed', detail: '这个角色没有这一层' } });
    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: ['coat', ''], show: [] }),
      { ok: false, error: { code: 'invalid_args', detail: '{hide, show: layer ids}' } });
    const sent = a.sent('set_layers').length;
    assert.deepEqual(await s.call('avatar.setLayers', 'birch', { hide: [], show: ['coat'] }),
      { ok: false, error: { code: 'character_changed', detail: '角色刚换过，这次没有改' } }, 'meant for a character no longer current');
    assert.equal(a.sent('set_layers').length, sent);

    // Rule 16: no reply within 10 s (here 0.1 s) is a failure, and the remembered appearance stays.
    a.ignore.add('set_appearance');
    assert.deepEqual(await s.call('avatar.setAppearance', 'default'), { ok: false, error: { code: 'failed', detail: '外观没有换成：timeout' } });
    assert.deepEqual((readState(s.support).last_appearance as Record<string, string>).aster, 'summer');
    a.ignore.add('set_layers');
    assert.deepEqual(await s.call('avatar.setLayers', 'aster', { hide: [], show: ['coat'] }), { ok: false, error: { code: 'failed', detail: '服装分层没有换成：timeout' } });
    assert.deepEqual((readState(s.support).hidden_layers as Record<string, string[]>).aster, ['coat']);
  } finally {
    s.done();
  }
});

test('at hello a remembered appearance and hidden layers that differ are sent once, and each remembered appearance\'s mod settings', { skip: UNIX_LINK }, async () => {
  const s = await stack({ state: { last_appearance: { aster: 'summer' }, hidden_layers: { aster: ['hat', 'gone'] } },
    config: { mod_settings: { aster: { default: { coat: 2 }, removed: { coat: 1 } } } } });
  try {
    const a = await s.avatar('mac');
    assert.ok(await until(2, () => a.sent('set_mod_settings').length + a.sent('set_layers').length + a.sent('set_appearance').length >= 3), `${a.got.map((m) => m.type)}`);
    assert.deepEqual(a.sent('set_appearance'), [{ v: 1, type: 'set_appearance', id: 'summer' }]);
    assert.deepEqual(a.sent('set_layers'), [{ v: 1, type: 'set_layers', hidden: ['hat'] }], 'only ids she lists');
    assert.deepEqual(a.sent('set_mod_settings').map(({ req: _, ...m }) => m),
      [{ v: 1, type: 'set_mod_settings', character: 'aster', appearance: 'default', values: { coat: 2 } }]);
    assert.ok(await until(2, () => (readState(s.support).hidden_layers as Record<string, string[]>).aster?.length === 1));
    assert.deepEqual(readState(s.support), { last_appearance: { aster: 'summer' }, hidden_layers: { aster: ['hat'] } });
    // An appearance she no longer lists takes its mod settings with it.
    assert.deepEqual(storedModSettings(s.config(), 'aster'), { default: { coat: 2 } });
  } finally {
    s.done();
  }
});

test('avatar.setActionSwitches stores the whole table in config.json and returns her reply; a stored table that differs from her list goes out once', { skip: UNIX_LINK }, async () => {
  const s = await stack({ config: { action_switches: { aster: { wave: false, idle: true } } } });
  try {
    const a = await s.avatar('mac');
    const reply = await s.call('avatar.setActionSwitches', 'aster', { idle: false });
    assert.deepEqual(reply, { ok: true, value: { switches: { wave: true, idle: false }, adjusted: [] } });
    assert.deepEqual(a.sent('set_action_switches').map((m) => m.switches), [{ wave: false, idle: true }, { wave: true, idle: false }],
      'the stored table on her list (rule 28), then the saved one');
    assert.deepEqual(storedSwitches(s.config(), 'aster'), { wave: true, idle: false });
    assert.equal(s.config().mute, false, 'the other keys stay');
    assert.deepEqual(await s.call('avatar.setActionSwitches', 'aster', { dance: true }), { ok: false, error: { code: 'invalid_args', detail: 'unknown action' } });
    assert.deepEqual(await s.call('avatar.setActionSwitches', 'aster', { wave: 1 }), { ok: false, error: { code: 'invalid_args', detail: 'switches' } });
  } finally {
    s.done();
  }
});

test('avatar.modSettings.set sends one appearance\'s set and stores what she drew; get reads config.json; a refused set stores nothing', { skip: UNIX_LINK }, async () => {
  const s = await stack();
  try {
    const a = await s.avatar('mac');
    assert.deepEqual(await s.call('avatar.modSettings.get', { character: 'aster' }), { ok: true, value: { appearances: {} } });
    const set = await s.call('avatar.modSettings.set', { character: 'aster', appearance: 'summer', values: { coat: 1 } });
    assert.deepEqual(set, { ok: true, value: { values: { coat: 1, color: 0 }, adjusted: [{ id: 'color', reason: 'defaulted' }] } });
    assert.deepEqual({ ...a.sent('set_mod_settings').at(-1), req: 0 },
      { v: 1, type: 'set_mod_settings', req: 0, character: 'aster', appearance: 'summer', values: { coat: 1 } });
    assert.deepEqual(await s.call('avatar.modSettings.get', { character: 'aster' }), { ok: true, value: { appearances: { summer: { coat: 1, color: 0 } } } });
    assert.deepEqual(await s.call('avatar.modSettings.set', { character: 'aster', appearance: 'plain', values: {} }),
      { ok: false, error: { code: 'failed', detail: '角色没有接受这组 mod 设置（这个外观可能没有开关表）' } });
    assert.deepEqual(storedModSettings(s.config(), 'aster'), { summer: { coat: 1, color: 0 } });
    assert.deepEqual(await s.call('avatar.modSettings.set', { character: 'aster', appearance: 'summer', values: { Coat: 1 } }),
      { ok: false, error: { code: 'invalid_args', detail: '{character, appearance of 1–64 bytes, values: ≤64 switch ids → 0–255}' } });
    assert.deepEqual(await s.call('avatar.modSettings.get', {}), { ok: false, error: { code: 'invalid_args', detail: '{character}' } });
  } finally {
    s.done();
  }
});

test('rule 26: one switch at a time; choices made while one runs keep only the last; prepare refused stops before the renderer', async () => {
  const sent: string[] = [], calls: string[] = [];
  let refuse = false;
  const ports: SwitchPorts = {
    agentdRunning: () => true,
    prepare: async (id) => (calls.push(`prepare ${id}`), refuse ? { kind: 'rejected', status: 409, reason: 'busy' } : { kind: 'prepared', switchId: id }),
    commit: async (id) => (calls.push(`commit ${id}`), { kind: 'committed' }),
    abort: async (id) => (calls.push(`abort ${id}`), { kind: 'aborted' }),
    setAgentdCharacter: async (id) => (calls.push(`set ${id}`), { kind: 'changed', changed: true }),
    readAgentd: async () => ({ character: 'a' }),
    setCharacter: (id) => (sent.push(id), true), restartAvatar: () => {}, persist: (id) => calls.push(`persist ${id}`),
    renderable: () => true, log: () => {},
  };
  const sw = new CharacterSwitch(ports);
  sw.avatar({ kind: 'current', id: 'a' });
  sw.select('b');
  sw.select('c');
  sw.select('d');
  assert.ok(await until(1, () => sent.length === 1));
  sw.avatar({ kind: 'changed', id: 'b' });
  assert.ok(await until(1, () => sent.length === 2));
  assert.deepEqual(sent, ['b', 'd'], 'c was replaced by d while b ran');
  sw.avatar({ kind: 'changed', id: 'd' });
  assert.ok(await until(1, () => !sw.busy && sw.current === 'd'));
  assert.deepEqual(calls, ['prepare b', 'commit b', 'persist b', 'prepare d', 'commit d', 'persist d']);

  refuse = true;
  assert.deepEqual(await sw.switchOutcome('e'), { kind: 'failed', stage: 'prepare', reason: 'busy' });
  assert.deepEqual(sent, ['b', 'd']);
  sw.held = true;
  assert.deepEqual(await sw.switchOutcome('e'), { kind: 'failed', stage: 'prepare', reason: '正在导入动作，导入完再切换' });
});

test('agentd without a character (an empty library) is a read, not a failed one: no retries, no failure line', async () => {
  let reads = 0, status = 200;
  const logs: string[] = [];
  const agentd = agentdSwitchPorts(async (method, path) => {
    if (method === 'GET' && path === '/state') reads++;
    return { status, body: new TextEncoder().encode(JSON.stringify({ character: null, switching: null })) };
  });
  const sw = new CharacterSwitch({ ...agentd, agentdRunning: () => true, setCharacter: () => true, restartAvatar: () => {}, persist: () => {},
    renderable: () => true, log: (line) => logs.push(line) });
  sw.readRetry = 0.001;
  await sw.agentdReady();
  assert.deepEqual([reads, logs], [1, []]);
  assert.equal(sw.current, null);
  status = 503;
  await sw.agentdReady();
  assert.deepEqual([reads, logs], [1 + sw.readAttempts, ['agentd character unknown: GET /state failed for 10 s']]);
});

test('a switch to or from a text-only character restarts the renderer as it and takes its hello for the reply', async () => {
  const restarts: string[] = [], persisted: string[] = [];
  const ports: SwitchPorts = {
    agentdRunning: () => false, prepare: async () => ({ kind: 'failed', reason: 'down' }), commit: async () => ({ kind: 'committed' }),
    abort: async () => ({ kind: 'aborted' }), setAgentdCharacter: async () => ({ kind: 'changed', changed: true }), readAgentd: async () => null,
    setCharacter: () => true, restartAvatar: (id) => restarts.push(id), persist: (id) => persisted.push(id),
    renderable: (id) => id !== 'aide', log: () => {},
  };
  const sw = new CharacterSwitch(ports);
  sw.agentdReported('aide');
  assert.equal(sw.current, 'aide', 'a text-only character has no hello: agentd names it');
  const outcome = sw.switchOutcome('aster');
  assert.ok(await until(1, () => restarts.length === 1));
  sw.avatar({ kind: 'current', id: 'aster' });
  assert.deepEqual(await outcome, { kind: 'switched' });
  assert.deepEqual([restarts, persisted], [['aster'], ['aster']]);
  assert.deepEqual(await sw.switchOutcome('aide'), { kind: 'switched' });
  assert.deepEqual([restarts, persisted], [['aster', 'aide'], ['aster', 'aide']]);
});

test('restartOnly (Windows, efw takes no set_character): a switch restarts the renderer as the new character between prepare and commit; a missing hello or a refused commit restarts it as the old one', async () => {
  const sent: string[] = [], calls: string[] = [];
  let commits: 'ok' | 'refused' = 'ok';
  // The fake supervisor restarts as the remembered last character, as index.ts's `renderer.restart()` does.
  let remembered = 'aster';
  const ports: SwitchPorts = {
    agentdRunning: () => true,
    prepare: async (id) => (calls.push(`prepare ${id}`), { kind: 'prepared', switchId: id }),
    commit: async (id) => (calls.push(`commit ${id}`), commits === 'ok' ? { kind: 'committed' } : { kind: 'rejected', status: 409, reason: 'stale' }),
    abort: async (id) => (calls.push(`abort ${id}`), { kind: 'aborted' }),
    setAgentdCharacter: async (id) => (calls.push(`set ${id}`), { kind: 'changed', changed: true }),
    readAgentd: async () => ({ character: 'aster' }),
    setCharacter: (id) => (sent.push(id), true), restartAvatar: () => calls.push(`restart ${remembered}`),
    persist: (id) => { remembered = id; },
    renderable: () => true, log: () => {},
  };
  const sw = new CharacterSwitch(ports);
  sw.restartOnly = true;
  sw.helloTimeout = 0.2;
  sw.avatar({ kind: 'current', id: 'aster' });
  const switched = sw.switchOutcome('birch');
  assert.ok(await until(1, () => calls.length === 2));
  assert.deepEqual(calls, ['prepare birch', 'restart birch']);
  sw.avatar({ kind: 'current', id: 'birch' });
  assert.deepEqual(await switched, { kind: 'switched' });
  assert.deepEqual(calls.splice(0), ['prepare birch', 'restart birch', 'commit birch']);
  assert.deepEqual([sw.current, remembered], ['birch', 'birch']);

  assert.deepEqual(await sw.switchOutcome('aster'), { kind: 'failed', stage: 'avatar', reason: 'timeout' });
  assert.deepEqual(calls.splice(0), ['prepare aster', 'restart aster', 'abort aster', 'restart birch']);
  assert.deepEqual([sw.current, remembered], ['birch', 'birch']);

  commits = 'refused';
  const refused = sw.switchOutcome('aster');
  assert.ok(await until(1, () => calls.length === 2));
  sw.avatar({ kind: 'current', id: 'aster' });
  assert.deepEqual(await refused, { kind: 'failed', stage: 'commit', reason: 'stale' });
  assert.deepEqual(calls.splice(0), ['prepare aster', 'restart aster', 'commit aster', 'commit aster', 'abort aster', 'restart birch']);
  assert.deepEqual([sw.current, remembered], ['birch', 'birch']);
  assert.deepEqual(sent, [], 'no set_character');
});

test('the launch carries the remembered mod settings as --agentic-complex-mod-settings, keys sorted, after the hidden layers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'A.app') }], avatar_executable: '/bin/true', agentd_dir: dir, python: '/usr/bin/false',
      agentd_port: 1, support_dir: join(dir, 's'), agentd_state_dir: join(dir, 'st'), gpu_hold_files: [] }));
    const config = loadConfig(configPath);
    const launch = (settings: Record<string, unknown>) => rendererArguments({ config, character: 'birch', parentPid: 1, startupPath: '/x',
      socketPath: null, captureDir: '/p', settings, state: { hidden_layers: { birch: ['hat'] } } });
    const args = launch({ mod_settings: { birch: { summer: { color: 2, coat: 1 }, bad: { Coat: 1 } }, aster: { default: { coat: 1 } } } });
    const at = args.indexOf('--agentic-complex-mod-settings');
    assert.deepEqual(args.slice(at - 2, at + 4), ['--agentic-complex-hidden-layers', 'hat', '--agentic-complex-mod-settings',
      '{"summer":{"coat":1,"color":2}}', '--agentic-complex-viewport', 'fullscreen']);
    assert.ok(!launch({ mod_settings: { birch: {} } }).includes('--agentic-complex-mod-settings'));
    assert.ok(!launch({}).includes('--agentic-complex-mod-settings'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what a switch writes keeps the other state.json and config.json keys', { skip: UNIX_LINK }, async () => {
  const before: Record<string, unknown> = { last_display: { aster: 69733248 }, hidden_layers: { birch: ['hat'], aster: [] }, trace_epoch: 1763600000000,
    last_appearance: { birch: 'mod_1a2b3c4d', aster: 'default' }, window_scale: { birch: 1.25 }, last_character: 'aster' };
  const s = await stack({ state: before, config: { onboarding_done: true, mod_settings: { birch: { mod_1a2b3c4d: { coat: 1, color: 2 } } } } });
  try {
    const a = await s.avatar('mac', 'aster');
    assert.deepEqual(await s.call('character.switchTo', 'birch'), { ok: true, value: { ok: true } });
    assert.deepEqual(a.sent('set_character')[0], { v: 1, type: 'set_character', id: 'birch', appearance: 'mod_1a2b3c4d', hidden_layers: ['hat'],
      mod_settings: { mod_1a2b3c4d: { coat: 1, color: 2 } } });
    const state = readState(s.support);
    assert.equal(state.last_character, 'birch');
    for (const key of ['window_scale', 'last_display', 'trace_epoch', 'hidden_layers']) assert.deepEqual(state[key], before[key], key);
    assert.deepEqual(s.config().onboarding_done, true);
  } finally {
    s.done();
  }
});

test("the preview's load carries the character's remembered mod settings, none when she has none", async () => {
  const loads: PreviewSelection[] = [];
  const view = { place: () => {}, load: async (sel: PreviewSelection) => (loads.push(sel), true), sequence: async () => {}, hide: () => {},
    progress: new PushSource('progress'), view: () => {} };
  const mods: Record<string, Record<string, Record<string, number>>> = { aster: { summer: { coat: 1 } } };
  let character = 'aster';
  const preview = new PreviewController({ view, avatar: () => ({ character, appearance: 'summer' }), modSettings: (id) => mods[id] ?? {},
    library: async (id) => ({ bundle: '/b', sha256: 'x', character: id, clips: [] }) });
  await preview.show({ x: 0, y: 0, w: 10, h: 10 }, null, false, 1);
  character = 'birch';
  await preview.show({ x: 0, y: 0, w: 10, h: 10 }, null, false, 2);
  assert.deepEqual(loads.map((l) => l.modSettings), [{ summer: { coat: 1 } }, null]);
});

test('a reply remembers what she wears; a failed one only logs and remembers nothing', () => {
  const support = mkdtempSync(join(tmpdir(), 'looks-reply-'));
  try {
    let emit: (e: LinkEvent) => void = () => {};
    const logs: string[] = [];
    const link = { on: (fn: (e: LinkEvent) => void) => { emit = fn; return () => {}; }, currentCharacter: 'aster' } as unknown as LooksOptions['link'];
    new AvatarLooks({ link, supportDir: support, configPath: join(support, 'config.json'), log: (l) => logs.push(l) }).start();
    emit({ kind: 'appearance', event: { kind: 'failed', id: 'summer', reason: 'timeout' } });
    emit({ kind: 'layers', event: { kind: 'failed', hidden: ['hat', 'coat'], reason: 'unknown_layer' } });
    assert.deepEqual(logs, ['AVATAR appearance switch to summer failed: timeout', 'AVATAR layers change to hidden=hat,coat failed: unknown_layer']);
    assert.deepEqual(readState(support), {});
    emit({ kind: 'appearance', event: { kind: 'changed', id: 'summer' } });
    emit({ kind: 'layers', event: { kind: 'changed', hidden: ['hat'] } });
    assert.deepEqual(readState(support), { last_appearance: { aster: 'summer' }, hidden_layers: { aster: ['hat'] } });
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test('a config.json that does not parse is never written over: saveSwitches throws, her mod-settings reports only log', async () => {
  const support = mkdtempSync(join(tmpdir(), 'looks-unreadable-'));
  try {
    const configPath = join(support, 'config.json'), bad = '{"services":{},';
    writeFileSync(configPath, bad);
    let emit: (e: LinkEvent) => void = () => {};
    const logs: string[] = [], sent: unknown[] = [];
    const receipt = { req: null, character: 'aster', appearance: 'summer', values: { coat: 1 }, adjusted: [] };
    const link = { on: (fn: (e: LinkEvent) => void) => { emit = fn; return () => {}; }, currentCharacter: 'aster',
      saveSwitches: async (character: string, switches: Record<string, boolean>) => (sent.push(switches), { character, switches, adjusted: [] }),
      setModSettings: async () => receipt } as unknown as LooksOptions['link'];
    const looks = new AvatarLooks({ link, supportDir: support, configPath, log: (l) => logs.push(l) });
    looks.start();
    await assert.rejects(async () => looks.saveSwitches('aster', { wave: false }));
    assert.deepEqual(sent, [], 'the table that was not stored is not sent');
    emit({ kind: 'modSettings', receipt });
    await assert.rejects(looks.saveModSettings('aster', 'summer', { coat: 1 }));
    assert.equal(readFileSync(configPath, 'utf8'), bad);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^AVATAR mod settings of aster not stored: /);
    assert.deepEqual(looks.modSettings('aster'), {}, 'a read takes the unreadable file as empty');
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test('avatar.setActionSwitches: two overlapping saves keep both changes; an id that is only an Object property is unknown', async () => {
  let table: Record<string, boolean> = { wave: true, idle: true };
  const saved: Record<string, boolean>[] = [];
  const avatar = { currentCharacter: 'aster', actions: async () => {
    const now = { ...table };
    await sleep(0.02);
    return { switches: now };
  } };
  const looks = { saveSwitches: async (character: string, switches: Record<string, boolean>) => {
    saved.push(switches);
    table = switches;
    return { character, switches, adjusted: [] };
  } };
  const ops = new Map(Object.entries(avatarOps({ surface: 'main', routes, avatar, looks } as unknown as OpsContext))), page = new PageSession(() => {});
  const call = (...args: unknown[]) => handle('main', { mainFrame: true, origin: ORIGIN }, { op: 'avatar.setActionSwitches', args }, ops, page);
  const [a, b] = await Promise.all([call('aster', { wave: false }), call('aster', { idle: false })]);
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
  assert.deepEqual(saved.at(-1), { wave: false, idle: false });
  assert.deepEqual(await call('aster', { toString: true }), { ok: false, error: { code: 'invalid_args', detail: 'unknown action' } });
});
