// Clicks on her and the desktop actions that act on her (src/main/interaction/shell.ts), as index.ts wires them: left
// clicks, claimRitual, gift, free roam and click-through all. A fake agentd, a fake link, a fake clock and a temporary config.json.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { BridgeFailure } from '../src/common/bridge.ts';
import type { ActionRow, Actions } from '../src/common/c3.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { interactionShell } from '../src/main/interaction/shell.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { settingsOps } from '../src/main/ops/settings.ts';

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
const row = (id: string, o: Partial<ActionRow> = {}): ActionRow => ({ id, name: id, section: 'interact', duration: null, trigger: '',
  required_reason: null, missing: null, ...o });

function harness(o: { status?: number; body?: unknown; offline?: boolean; settings?: Record<string, unknown>; quickInputOpen?: boolean;
  actions?: ActionRow[]; noLink?: boolean; noDesktop?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'interaction-'));
  const configPath = join(dir, 'config.json');
  const calls: string[] = [], lines: string[] = [], requests: { method: string; path: string; json: unknown }[] = [];
  let now = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  const link = { clickThroughAll: false, currentCharacter: 'aster' as string | null,
    actions: async (character: string): Promise<Actions> => ({ v: 1, type: 'actions', character, actions: o.actions ?? [], switches: {} }),
    playAction: async (character: string, id: string, speed: number, loop: boolean) => { calls.push(`play ${character} ${id} ${speed} ${loop}`); } };
  const desktop = { quickInputOpen: o.quickInputOpen ?? false, openQuickInput: () => calls.push('quickInput'),
    notice: (text: string) => calls.push(`notice ${text}`), pushState: () => calls.push('pushState') };
  const request = async (method: string, path: string, json: unknown) => {
    requests.push({ method, path, json });
    if (o.offline) throw new Error('ECONNREFUSED');
    return { status: o.status ?? 202, body: JSON.stringify(o.body ?? {}) };
  };
  // The main window's settings ops over this config.json, as index.ts gives free roam.
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: configPath, supportDir: dir, devResources: null },
    agentd: { request: async (method: string, path: string, json: unknown) => {
      const r = await request(method, path, json);
      return { status: r.status, body: Buffer.from(r.body) };
    } } as unknown as OpsContext['agentd'],
    store: null, diag: null, supervisor: null, library: null, confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource,
    saved: { fps: () => {}, hotkey: () => {}, renderLive: (keys) => calls.push(`renderLive ${keys.join(',')}`) },
    log: (line) => lines.push(line),
  };
  const save = settingsOps(ctx)['settings.save']!;
  const shell = interactionShell({
    request,
    settings: () => { try { return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { return o.settings ?? {}; } },
    saveSettings: async (changes) => (await save([changes], new PageSession(() => {}))) as { error?: string },
    link: o.noLink ? null : link,
    desktop: () => (o.noDesktop ? null : desktop),
    openSessions: () => calls.push('sessions'),
    onContextMenu: (at, held) => calls.push(`menu ${at.x},${at.y}${held ? ' held' : ''}`),
    onRingPointer: (phase, at) => calls.push(`ring ${phase} ${at.x},${at.y}`),
    clickThroughChanged: () => calls.push('clickThroughChanged'),
    log: (line) => lines.push(line),
    clock: { now: () => now, after: (s, fn) => { timers.push({ at: now + s, fn }); } },
  });
  /** Moves the clock to `t` seconds after the start and runs the timers due by then. */
  const advance = async (t: number) => {
    now = 1000 + t;
    for (const timer of timers.splice(0).filter((x) => { if (x.at <= now) return true; timers.push(x); return false; })) timer.fn();
    await settle();
  };
  return { shell, calls, lines, requests, link, configPath, advance, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a single click on her taps for a ritual 0.8 s after it, with the count and, for one click, the region', async () => {
  const h = harness();
  h.shell.click({ kind: 'left', at: { x: 10, y: 20 }, region: 'head' });
  await h.advance(0.79);
  assert.equal(h.requests.length, 0);
  await h.advance(0.8);
  assert.equal(h.requests.length, 1);
  const { method, path, json } = h.requests[0]!;
  assert.equal(`${method} ${path}`, 'POST /interaction/tap');
  const body = json as Record<string, unknown>;
  assert.match(body.at as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
  assert.deepEqual({ ...body, at: null }, { at: null, count: 1, region: 'head' });
  assert.deepEqual(h.lines, ['RITUAL tap status=202']);
  assert.deepEqual(h.calls, [], 'avatar_click interact opens nothing');
  // A single click within 20 s of the last request asks nothing.
  h.shell.click({ kind: 'left', at: { x: 10, y: 20 }, region: 'head' });
  await h.advance(4);
  assert.equal(h.requests.length, 1);
  // A run of clicks asks as it ends, within the 20 s too, without a region.
  h.shell.click({ kind: 'left', at: { x: 10, y: 20 }, region: 'head' });
  await h.advance(4.5);
  h.shell.click({ kind: 'left', at: { x: 10, y: 20 }, region: 'head' });
  await h.advance(5);
  h.shell.click({ kind: 'left', at: { x: 10, y: 20 }, region: 'head' });
  await h.advance(5.79);
  assert.equal(h.requests.length, 1);
  await h.advance(5.8);
  assert.equal(h.requests.length, 2);
  assert.deepEqual({ ...(h.requests[1]!.json as Record<string, unknown>), at: null }, { at: null, count: 3 });
  h.done();
});

test('a run that ends while the last tap is unanswered asks nothing', async () => {
  let answer!: () => void;
  const h = harness();
  const shell = interactionShell({ request: async (method, path, json) => {
    h.requests.push({ method, path, json });
    await new Promise<void>((r) => { answer = r; });
    return { status: 202, body: '{}' };
  }, settings: () => ({}), saveSettings: async () => ({}), link: null, desktop: () => null, openSessions() {}, onContextMenu() {},
  onRingPointer() {}, clickThroughChanged() {}, log() {}, clock: { now: () => clock, after: (sec, fn) => { timers.push({ at: clock + sec, fn }); } } });
  let clock = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const advance = async (t: number) => {
    clock = t;
    for (const timer of timers.splice(0).filter((x) => { if (x.at <= clock) return true; timers.push(x); return false; })) timer.fn();
    await settle();
  };
  const left = { kind: 'left', at: { x: 0, y: 0 }, region: null } as const;
  shell.click(left);
  shell.click(left);
  await advance(2);
  assert.equal(h.requests.length, 1);
  shell.click(left);
  shell.click(left);
  await advance(4);
  assert.equal(h.requests.length, 1);
  answer();
  await settle();
  shell.click(left);
  shell.click(left);
  await advance(6);
  assert.equal(h.requests.length, 2);
  answer();
  h.done();
});

test('a tap agentd turns down says why in the bubble; an unreachable agentd is status 0', async () => {
  const busy = harness({ status: 409, body: { while: 'working' } });
  busy.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await busy.advance(2);
  assert.deepEqual(busy.calls, ['notice 角色正在处理上一轮对话，请稍候']);
  assert.deepEqual(busy.lines, ['RITUAL tap status=409']);
  busy.done();
  // While she speaks a click already cut her off: nothing to say.
  const speaking = harness({ status: 409, body: { while: 'speaking' } });
  speaking.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await speaking.advance(2);
  assert.deepEqual(speaking.calls, []);
  speaking.done();
  const offline = harness({ offline: true });
  offline.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await offline.advance(2);
  assert.deepEqual(offline.calls, ['notice 未能收到角色回应，请稍后再试']);
  assert.deepEqual(offline.lines, ['RITUAL tap status=0']);
  offline.done();
});

test('avatar_click quick_input opens 快速输入 as a run of clicks ends, unless it is open; read at the click', async () => {
  const h = harness({ settings: { avatar_click: 'quick_input' } });
  h.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await h.advance(0.5);
  h.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await h.advance(1.29);
  assert.deepEqual(h.calls, []);
  await h.advance(2);
  assert.deepEqual(h.calls, ['quickInput']);
  h.done();
  const open = harness({ settings: { avatar_click: 'quick_input' }, quickInputOpen: true });
  open.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await open.advance(2);
  assert.deepEqual(open.calls, []);
  open.done();
  // Without the desktop panels the tap still goes out.
  const bare = harness({ settings: { avatar_click: 'quick_input' }, noDesktop: true, status: 409, body: { while: 'working' } });
  bare.shell.click({ kind: 'left', at: { x: 0, y: 0 }, region: null });
  await bare.advance(2);
  assert.equal(bare.requests.length, 1);
  bare.done();
});

test('a double click opens the sessions page and takes back its first half; the right button opens the character menu', async () => {
  const h = harness({ settings: { avatar_click: 'quick_input' }, status: 204 });
  h.shell.click({ kind: 'left', at: { x: 5, y: 6 }, region: null });
  h.shell.click({ kind: 'double' });
  await h.advance(2);
  assert.equal(h.requests.length, 0);
  h.shell.click({ kind: 'right', at: { x: 300, y: 400 } });
  assert.deepEqual(h.calls, ['sessions', 'menu 300,400']);
  // Each right click is one wheel record for the daily brief.
  await settle();
  assert.deepEqual(h.requests, [{ method: 'POST', path: '/interaction/record', json: { kind: 'wheel' } }]);
  assert.deepEqual(h.lines, []);
  h.done();
});

test('A right press on her opens the wheel held there and is one wheel record; its moves and release go to the wheel', async () => {
  const h = harness({ status: 204 });
  h.shell.rightDrag({ phase: 'down', at: { x: 300, y: 400 } });
  h.shell.rightDrag({ phase: 'move', at: { x: 320, y: 430 } });
  h.shell.rightDrag({ phase: 'up', at: { x: 330, y: 450 } });
  assert.deepEqual(h.calls, ['menu 300,400 held', 'ring move 320,430', 'ring up 330,450']);
  await settle();
  assert.deepEqual(h.requests, [{ method: 'POST', path: '/interaction/record', json: { kind: 'wheel' } }]);
  h.done();
});

test('a wheel record agentd does not take is logged', async () => {
  const h = harness({ offline: true });
  h.shell.click({ kind: 'right', at: { x: 1, y: 2 } });
  await settle();
  assert.deepEqual(h.lines, ['RECORD kind=wheel status=0']);
  h.done();
});

test('claimRitual (the ritual tag) taps with no count or region and fails without one', async () => {
  const h = harness({ status: 200 });
  assert.equal(await h.shell.actions.claimRitual(), '本次没有可播放的回应');
  assert.deepEqual(Object.keys(h.requests[0]!.json as object), ['at']);
  h.done();
  const ok = harness();
  assert.equal(await ok.shell.actions.claimRitual(), null);
  ok.done();
});

test('the gift plays her gift action at speed 1, then tells agentd; a missing one, no link or a switch fails it', async () => {
  const h = harness({ actions: [row('wave'), row('interact_receive_gift')], status: 500 });
  await h.shell.actions.gift();
  await settle();
  assert.deepEqual(h.calls, ['play aster interact_receive_gift 1 false']);
  assert.deepEqual(h.requests.map((r) => [r.method, r.path, r.json]), [['POST', '/interaction/gift', { action_id: 'interact_receive_gift' }]]);
  assert.deepEqual(h.lines, ['GIFT action_id=interact_receive_gift status=500']);
  h.done();
  const missing = harness({ actions: [row('receive_gift', { missing: '缺少收礼动作的资源' })] });
  await assert.rejects(missing.shell.actions.gift(), { message: '缺少收礼动作的资源' });
  missing.done();
  const none = harness({ actions: [row('wave')] });
  await assert.rejects(none.shell.actions.gift(), { message: '当前角色尚未导入原作赠礼动作' });
  none.done();
  const move = harness({ actions: [row('receive_gift', { section: 'move' })] });
  await assert.rejects(move.shell.actions.gift(), { message: '该动作不支持单独播放' });
  move.done();
  const unlinked = harness({ noLink: true });
  await assert.rejects(unlinked.shell.actions.gift(), { message: '角色渲染进程未连接（配置异常）' });
  unlinked.done();
  const gone = harness({ actions: [row('receive_gift')] });
  gone.link.currentCharacter = null;
  await assert.rejects(gone.shell.actions.gift(), { message: '当前角色已变更，请重新选择操作' });
  assert.deepEqual([...missing.requests, ...none.requests, ...gone.requests], []);
  gone.done();
});

test('free roam flips stay_mode between stay and roam through the settings save: out of 半身固定 she is framed whole again', async () => {
  const h = harness({ status: 503 });
  writeFileSync(h.configPath, JSON.stringify({ stay_mode: 'bust', sit_on_windows: false, character: 'aster' }));
  await h.shell.actions.freeRoam();
  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')), { character: 'aster', sit_on_windows: false, stay_mode: 'roam' });
  assert.deepEqual(h.calls, ['renderLive stay_mode', 'pushState']);
  assert.deepEqual(h.requests.map((r) => [r.method, r.path, r.json]), [['PUT', '/behavior/switches',
    { stay_in_place: false, sit_window_top: false, hold_window_edge: true, fullscreen_give_way: true }]]);
  assert.deepEqual(h.lines, ['behavior switches put status=503']);
  await h.shell.actions.freeRoam();
  assert.equal(JSON.parse(readFileSync(h.configPath, 'utf8')).stay_mode, 'stay');
  assert.equal((h.requests[1]!.json as Record<string, unknown>).stay_in_place, true);
  assert.equal(h.calls.filter((c) => c.startsWith('renderLive')).length, 1, 'roam to stay keeps her framing');
  // A config.json that does not read is not written over, and the action fails with why.
  writeFileSync(h.configPath, '[1]');
  await assert.rejects(h.shell.actions.freeRoam(), (e) => e instanceof BridgeFailure && e.code === 'failed'
    && e.detail === 'config.json 读不了，没有保存');
  assert.equal(readFileSync(h.configPath, 'utf8'), '[1]');
  assert.match(h.lines.at(-1)!, /^free roam not saved: /);
  assert.equal(h.calls.filter((c) => c === 'pushState').length, 2);
  h.done();
});

test('click-through-all from the desktop toggles the link\'s and logs it; without a link it only logs', () => {
  const h = harness();
  h.shell.actions.clickThroughAll();
  assert.equal(h.link.clickThroughAll, true);
  h.shell.actions.clickThroughAll();
  assert.equal(h.link.clickThroughAll, false);
  assert.deepEqual(h.calls, ['clickThroughChanged', 'clickThroughChanged']);
  assert.deepEqual(h.lines, ['CLICK_THROUGH on source=desktop', 'CLICK_THROUGH off source=desktop']);
  h.done();
  const bare = harness({ noLink: true });
  bare.shell.actions.clickThroughAll();
  assert.deepEqual(bare.lines, ['CLICK_THROUGH source=desktop: no avatar link (config failed)']);
  bare.done();
});
