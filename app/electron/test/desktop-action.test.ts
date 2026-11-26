// `desktop.action` (src/common/desktop-action.ts) and its
// argument check: each wired name reaches its function and answers null; one whose port is not given is not_implemented. The clicks on her
// that claim a ritual and the gift's pick.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeFailure } from '../src/common/bridge.ts';
import type { ActionRow } from '../src/common/c3.ts';
import {
  DESKTOP_ACTIONS, desktopAction, DesktopPlay, giftAction, localIso, opensQuickInput, RitualTap, ritualFailure,
  type DesktopActionPorts,
} from '../src/common/desktop-action.ts';

function setup(quietFails = false, ritual: string | null = null) {
  const calls: unknown[][] = [];
  const ports: DesktopActionPorts = {
    look: () => calls.push(['look']),
    setHidden: (h) => calls.push(['setHidden', h]),
    setQuiet: async (until) => {
      calls.push(['setQuiet', until]);
      if (quietFails) throw new BridgeFailure('failed', 'HTTP 503');
    },
    resetPosition: () => calls.push(['resetPosition']),
    quit: () => calls.push(['quit']),
    quickInput: (scope) => calls.push(['quickInput', scope]),
    resetBoxes: () => calls.push(['resetBoxes']),
    clickThroughAll: () => calls.push(['clickThroughAll']),
    gift: async () => { calls.push(['gift']); },
    freeRoam: async () => { calls.push(['freeRoam']); },
    openStack: () => calls.push(['openStack']),
    resize: () => calls.push(['resize']),
    photo: () => calls.push(['photo']),
    talk: (phase) => calls.push(['talk', phase]),
    stopPlay: () => calls.push(['stopPlay']),
    pose: async (id) => { calls.push(['pose', id]); },
    claimRitual: async () => {
      calls.push(['claimRitual']);
      return ritual;
    },
    now: () => 1_800_000_000_000,
  };
  return { calls, ports, run: desktopAction(ports) };
}

async function failure(p: unknown): Promise<{ code: string; detail: string }> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BridgeFailure);
    return { code: e.code, detail: e.detail };
  }
  assert.fail('did not throw');
}

test('the names are DesktopAction\'s', () => {
  assert.deepEqual([...DESKTOP_ACTIONS], ['look', 'hide', 'show', 'clickThroughAll', 'quiet', 'quietEnd', 'gift', 'freeRoam',
    'resetPosition', 'resize', 'photo', 'quit', 'resetBoxes', 'openStack', 'claimRitual', 'quickInput', 'talk', 'stopPlay', 'pose']);
});

test('wired actions reach their function and answer null', async () => {
  const { calls, run } = setup();
  for (const [name, arg] of [['look'], ['hide'], ['show'], ['quiet'], ['quietEnd'],
    ['resetPosition'], ['quit'], ['quickInput'], ['quickInput', '{"scopeId":"s1","files":2}'],
    ['resetBoxes'], ['clickThroughAll'], ['gift'], ['freeRoam'], ['openStack'],
    ['claimRitual'], ['resize'], ['photo'], ['talk', 'start'], ['talk', 'stop'], ['stopPlay'], ['pose', 'pose_sit'], ['pose']] as [string, string?][]) {
    assert.equal(await run(arg === undefined ? [name] : [name, arg], null), null, name);
  }
  assert.deepEqual(calls, [['look'], ['setHidden', true], ['setHidden', false], ['setQuiet', 1_800_000_000 + 1800], ['setQuiet', null],
    ['resetPosition'], ['quit'], ['quickInput', null],
    ['quickInput', { scopeId: 's1', files: 2 }], ['resetBoxes'],
    ['clickThroughAll'], ['gift'], ['freeRoam'], ['openStack'], ['claimRitual'], ['resize'], ['photo'], ['talk', 'start'],
    ['talk', 'stop'], ['stopPlay'], ['pose', 'pose_sit'], ['pose', null]]);
});

test('claimRitual fails with why agentd took no tap, and a failed gift fails the action', async () => {
  const { calls, run } = setup(false, '角色正在处理上一轮对话，请稍候');
  assert.deepEqual(await failure(run(['claimRitual'], null)), { code: 'failed', detail: '角色正在处理上一轮对话，请稍候' });
  const gift = desktopAction({ ...setup().ports, gift: async () => { throw new Error('当前角色包尚未导入原作收礼动作'); } });
  // The bridge answers `failed` with the message.
  await assert.rejects(async () => gift(['gift'], null), { message: '当前角色包尚未导入原作收礼动作' });
  assert.deepEqual(calls, [['claimRitual']]);
});

test('quickInput takes only a {scopeId, files} scope and talk only start or stop', async () => {
  const { calls, run } = setup();
  for (const arg of ['s1', '{"scopeId":"","files":2}', '{"scopeId":"s1"}', '{"scopeId":"s1","files":1.5}', '[]']) {
    assert.deepEqual(await failure(run(['quickInput', arg], null)), { code: 'failed', detail: 'quickInput 的参数应是 {scopeId, files}' }, arg);
  }
  assert.deepEqual(await failure(run(['talk', 'hold'], null)), { code: 'invalid_args', detail: 'talk 的参数应是 start 或 stop' });
  assert.deepEqual(await failure(run(['talk'], null)), { code: 'failed', detail: 'talk 缺少参数' });
  assert.deepEqual(calls, []);
});

test('an action whose port the shell does not give is not_implemented', async () => {
  const { calls, ports } = setup();
  const { clickThroughAll: _a, gift: _b, freeRoam: _c, openStack: _e, claimRitual: _f, talk: _h, stopPlay: _i,
    pose: _j, photo: _k, resize: _l, ...bare } = ports;
  const run = desktopAction(bare);
  for (const name of ['clickThroughAll', 'gift', 'freeRoam', 'openStack', 'claimRitual', 'resize', 'photo', 'stopPlay', 'pose']) {
    assert.deepEqual(await failure(run([name], null)), { code: 'not_implemented', detail: `desktop.action ${name}` });
  }
  assert.deepEqual(await failure(run(['talk', 'start'], null)), { code: 'not_implemented', detail: 'desktop.action talk' });
  assert.deepEqual(calls, []);
});

test('a name outside the list, or an id that is not a 1–256 byte string, is invalid_args', async () => {
  const { run } = setup();
  for (const args of [[], ['fly'], [3], ['hide', ''], ['hide', 5], ['pose', 'x'.repeat(257)], ['pose', '佩'.repeat(86)]]) {
    assert.deepEqual(await failure(run(args, null)), { code: 'invalid_args', detail: 'a DesktopActionName and an optional id' },
      JSON.stringify(args));
  }
  assert.equal(await run(['pose', '佩'.repeat(85)], null), null);
  assert.equal(await run(['hide', null], null), null);
});

test('a failed quiet request fails the action', async () => {
  const { run } = setup(true);
  assert.deepEqual(await failure(run(['quiet'], null)), { code: 'failed', detail: 'HTTP 503' });
});

test('a free roam that was not saved fails the action, after the save ends', async () => {
  const saved: string[] = [];
  const run = desktopAction({ ...setup().ports, freeRoam: async () => {
    await new Promise((r) => setImmediate(r));
    saved.push('done');
    throw new BridgeFailure('failed', '自由活动未保存：config.json 读不了，没有保存');
  } });
  assert.deepEqual(await failure(run(['freeRoam'], null)), { code: 'failed', detail: '自由活动未保存：config.json 读不了，没有保存' });
  assert.deepEqual(saved, ['done']);
});

test('RitualTap: a single click asks 0.8 s after it, unless within 20 s of the last request', () => {
  const t = new RitualTap();
  t.click(100);
  assert.equal(t.settled(100.79), null);
  assert.deepEqual(t.settled(100.8), { kind: 'ask', count: 1 });
  assert.equal(t.settled(102), null, 'once per click');
  t.answered();
  t.click(110);
  assert.deepEqual(t.settled(110.8), { kind: 'quiet' });
  // A quiet click is not carried into a later request.
  t.click(130);
  assert.deepEqual(t.settled(130.8), { kind: 'ask', count: 1 });
});

test('RitualTap: clicks each within 0.8 s of the last are one run, asked for as it ends, past the 20 s spacing', () => {
  const t = new RitualTap();
  t.click(100);
  assert.deepEqual(t.settled(100.8), { kind: 'ask', count: 1 });
  t.answered();
  t.click(105);
  t.click(105.5);
  assert.equal(t.settled(106), null, 'the run goes on');
  t.click(106);
  assert.equal(t.settled(106.7), null);
  assert.deepEqual(t.settled(106.8), { kind: 'ask', count: 3 }, 'within 20 s of the last request');
  t.answered();
  for (let i = 0; i < 30; i += 1) t.click(200 + i * 0.5);
  assert.deepEqual(t.settled(215.3), { kind: 'ask', count: 20 }, 'agentd takes up to 20');
});

test('RitualTap: a run that ends while a request is out asks nothing', () => {
  const t = new RitualTap();
  t.click(100);
  t.click(100.5);
  assert.deepEqual(t.settled(101.3), { kind: 'ask', count: 2 });
  t.click(103);
  t.click(103.5);
  assert.deepEqual(t.settled(104.3), { kind: 'quiet' });
  t.answered();
  t.click(106);
  t.click(106.5);
  assert.deepEqual(t.settled(107.3), { kind: 'ask', count: 2 });
});

test('RitualTap: a double click takes back its first half', () => {
  const t = new RitualTap();
  t.click(100);
  t.doubleClick();
  assert.equal(t.settled(102), null);
  t.click(110);
  assert.deepEqual(t.settled(110.8), { kind: 'ask', count: 1 });
});

test('avatar_click quick_input opens 快速输入; any other value or none is interact', () => {
  assert.equal(opensQuickInput('quick_input'), true);
  for (const v of ['interact', undefined, null, 1, 'QUICK_INPUT']) assert.equal(opensQuickInput(v), false);
});

test('the tap\'s `at` is ISO 8601 in the local zone, without fractions', () => {
  const ms = Date.UTC(2026, 10, 20, 1, 5, 9, 500);
  assert.equal(localIso(ms, -480), '2026-11-20T09:05:09+08:00');
  assert.equal(localIso(ms, 0), '2026-11-20T01:05:09Z');
  assert.equal(localIso(ms, 210), '2026-11-19T21:35:09-03:30');
});

test('claimRitual\'s answers: what a click on her says, and what the ritual tag says', () => {
  const cases: [number, unknown, string | null, string | null][] = [
    [202, {}, null, null],
    [409, { while: 'working' }, '角色正在处理上一轮对话，请稍候', '角色正在处理上一轮对话，请稍候'],
    [409, { while: 'speaking' }, null, '角色正在语音播报，请稍后再试'],
    [409, { error: 'switching' }, '正在切换角色，请稍后再试', '正在切换角色，请稍后再试'],
    [503, { error: 'no_llm' }, '执行内核尚未就绪', '执行内核尚未就绪'],
    [200, {}, null, '本次没有可播放的回应'],
    [503, { error: 'other' }, '未能收到角色回应，请稍后再试', '未能收到角色回应，请稍后再试'],
    [0, null, '未能收到角色回应，请稍后再试', '未能收到角色回应，请稍后再试'],
  ];
  for (const [status, body, click, tag] of cases) {
    assert.equal(ritualFailure(status, body, 2), click, `${status} ${JSON.stringify(body)} click`);
    assert.equal(ritualFailure(status, body, null), tag, `${status} ${JSON.stringify(body)} tag`);
  }
});

test('the gift is the first of receive_gift, library_interact_receive_gift, interact_receive_gift she has', () => {
  const row = (id: string): ActionRow => ({ id, name: id, section: 'interact', duration: null, trigger: '', required_reason: null, missing: null });
  assert.equal(giftAction([row('wave'), row('interact_receive_gift'), row('library_interact_receive_gift')])?.id, 'library_interact_receive_gift');
  assert.equal(giftAction([row('wave')]), null);
});

test('DesktopPlay: a play from its `started` until a final receipt of it or the lost link, whoever sent it; 停止 stops that play', () => {
  const p = new DesktopPlay(), sent: unknown[] = [];
  const played = (play_id: string, id: string, phase: string) => p.played({ v: 1, type: 'action_played', play_id, id, phase, reason: null });
  assert.equal(p.id, null);
  assert.equal(played('a', 'mmd_lamb', 'started'), true);
  assert.equal(p.id, 'mmd_lamb');
  // The next item of a list: the old one ends, the new one starts.
  assert.equal(played('a', 'mmd_lamb', 'completed'), true);
  assert.equal(p.id, null);
  assert.equal(played('b', 'mmd_jile', 'started'), true);
  assert.equal(played('old', 'wave', 'interrupted'), false);
  assert.equal(p.id, 'mmd_jile');
  p.stop((m) => sent.push(m) > 0, ['actions', 'action_loop']);
  assert.deepEqual(sent, [{ v: 1, type: 'stop_action', play_id: 'b' }]);
  assert.throws(() => p.stop(() => true, ['actions']), { message: '当前版本角色暂不支持停止动作' });
  assert.throws(() => p.stop(() => false, ['action_loop']), { message: '当前版本角色暂不支持停止动作' });
  assert.equal(p.lost(), true);
  assert.equal(p.lost(), false);
  assert.equal(p.id, null);
  // Nothing plays: nothing to stop.
  p.stop(() => assert.fail('sent'), []);
});
