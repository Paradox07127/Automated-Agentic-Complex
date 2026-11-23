// `desktop.action` (src/common/desktop-action.ts) and its
// argument check: each wired name reaches its function and answers null; one whose port is not given is not_implemented. The clicks on her
// that claim a ritual and the gift's pick.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeFailure } from '../src/common/bridge.ts';
import type { ActionRow } from '../src/common/c3.ts';
import {
  DESKTOP_ACTIONS, desktopAction, giftAction, localIso, opensQuickInput, RitualTap, ritualFailure,
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
    switchCharacter: (id) => calls.push(['switchCharacter', id]),
    placeOnScreen: (id) => calls.push(['placeOnScreen', id]),
    resetPosition: () => calls.push(['resetPosition']),
    restartAll: () => calls.push(['restartAll']),
    quit: () => calls.push(['quit']),
    quickInput: (scope) => calls.push(['quickInput', scope]),
    cmdMode: (mode) => calls.push(['cmdMode', mode]),
    resetBoxes: () => calls.push(['resetBoxes']),
    clickThroughAll: () => calls.push(['clickThroughAll']),
    gift: async () => { calls.push(['gift']); },
    freeRoam: () => calls.push(['freeRoam']),
    openSessions: () => calls.push(['openSessions']),
    openStack: () => calls.push(['openStack']),
    resize: () => calls.push(['resize']),
    talk: (phase) => calls.push(['talk', phase]),
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
    'switchCharacter', 'placeOnScreen', 'resetPosition', 'resize', 'restartAll', 'quit', 'resetBoxes', 'openSessions', 'openStack',
    'claimRitual', 'quickInput', 'cmdMode', 'talk']);
});

test('wired actions reach their function and answer null', async () => {
  const { calls, run } = setup();
  for (const [name, arg] of [['look'], ['hide'], ['show'], ['quiet'], ['quietEnd'], ['switchCharacter', 'aster'], ['placeOnScreen', '4'],
    ['resetPosition'], ['restartAll'], ['quit'], ['quickInput'], ['quickInput', '{"scopeId":"s1","files":2}'], ['cmdMode', 'ring'],
    ['cmdMode', 'input'], ['resetBoxes'], ['clickThroughAll'], ['gift'], ['freeRoam'], ['openSessions'], ['openStack'],
    ['claimRitual'], ['resize'], ['talk', 'start'], ['talk', 'stop']] as [string, string?][]) {
    assert.equal(await run(arg === undefined ? [name] : [name, arg], null), null, name);
  }
  assert.deepEqual(calls, [['look'], ['setHidden', true], ['setHidden', false], ['setQuiet', 1_800_000_000 + 1800], ['setQuiet', null],
    ['switchCharacter', 'aster'], ['placeOnScreen', '4'], ['resetPosition'], ['restartAll'], ['quit'], ['quickInput', null],
    ['quickInput', { scopeId: 's1', files: 2 }], ['cmdMode', 'ring'], ['quickInput', null], ['resetBoxes'],
    ['clickThroughAll'], ['gift'], ['freeRoam'], ['openSessions'], ['openStack'], ['claimRitual'], ['resize'], ['talk', 'start'],
    ['talk', 'stop']]);
});

test('claimRitual fails with why agentd took no tap, and a failed gift fails the action', async () => {
  const { calls, run } = setup(false, '她在忙，等这一轮做完');
  assert.deepEqual(await failure(run(['claimRitual'], null)), { code: 'failed', detail: '她在忙，等这一轮做完' });
  const gift = desktopAction({ ...setup().ports, gift: async () => { throw new Error('当前角色包尚未导入原作收礼动作'); } });
  // The bridge answers `failed` with the message.
  await assert.rejects(async () => gift(['gift'], null), { message: '当前角色包尚未导入原作收礼动作' });
  assert.deepEqual(calls, [['claimRitual']]);
});

test('quickInput takes only a {scopeId, files} scope, cmdMode only ring or input, and talk only start or stop', async () => {
  const { calls, run } = setup();
  for (const arg of ['s1', '{"scopeId":"","files":2}', '{"scopeId":"s1"}', '{"scopeId":"s1","files":1.5}', '[]']) {
    assert.deepEqual(await failure(run(['quickInput', arg], null)), { code: 'failed', detail: 'quickInput 的参数应是 {scopeId, files}' }, arg);
  }
  for (const mode of ['console', 'tune']) {
    assert.deepEqual(await failure(run(['cmdMode', mode], null)), { code: 'invalid_args', detail: '未知的桌面操作面板' }, mode);
  }
  assert.deepEqual(await failure(run(['cmdMode'], null)), { code: 'failed', detail: 'cmdMode 缺少参数' });
  assert.deepEqual(await failure(run(['talk', 'hold'], null)), { code: 'invalid_args', detail: 'talk 的参数应是 start 或 stop' });
  assert.deepEqual(await failure(run(['talk'], null)), { code: 'failed', detail: 'talk 缺少参数' });
  assert.deepEqual(calls, []);
});

test('an action whose port the shell does not give is not_implemented', async () => {
  const { calls, ports } = setup();
  const { clickThroughAll: _a, gift: _b, freeRoam: _c, openSessions: _d, openStack: _e, claimRitual: _f, resize: _g, talk: _h, ...bare } = ports;
  const run = desktopAction(bare);
  for (const name of ['clickThroughAll', 'gift', 'freeRoam', 'openSessions', 'openStack', 'claimRitual', 'resize']) {
    assert.deepEqual(await failure(run([name], null)), { code: 'not_implemented', detail: `desktop.action ${name}` });
  }
  assert.deepEqual(await failure(run(['talk', 'start'], null)), { code: 'not_implemented', detail: 'desktop.action talk' });
  assert.deepEqual(calls, []);
});

test('a name outside the list, or an id that is not a 1–256 byte string, is invalid_args', async () => {
  const { run } = setup();
  for (const args of [[], ['fly'], [3], ['hide', ''], ['hide', 5], ['switchCharacter', 'x'.repeat(257)], ['switchCharacter', '佩'.repeat(86)]]) {
    assert.deepEqual(await failure(run(args, null)), { code: 'invalid_args', detail: 'a DesktopActionName and an optional id' },
      JSON.stringify(args));
  }
  assert.equal(await run(['switchCharacter', '佩'.repeat(85)], null), null);
  assert.equal(await run(['hide', null], null), null);
});

test('switchCharacter and placeOnScreen without an id fail with 缺少参数', async () => {
  const { calls, run } = setup();
  assert.deepEqual(await failure(run(['switchCharacter'], null)), { code: 'failed', detail: 'switchCharacter 缺少参数' });
  assert.deepEqual(await failure(run(['placeOnScreen'], null)), { code: 'failed', detail: 'placeOnScreen 缺少参数' });
  assert.deepEqual(calls, []);
});

test('a failed quiet request fails the action', async () => {
  const { run } = setup(true);
  assert.deepEqual(await failure(run(['quiet'], null)), { code: 'failed', detail: 'HTTP 503' });
});

test('RitualTap: a single click asks once it settles (0.40 s), counting the repeat clicks since the last request', () => {
  const t = new RitualTap();
  t.click(100);
  assert.equal(t.settled(100.39), null);
  assert.deepEqual(t.settled(100.40), { kind: 'ask', count: 1 });
  assert.equal(t.settled(101), null, 'once per click');
  // Clicks within 4 s of the last are repeat clicking: they ask nothing, but count toward the next request.
  t.click(102);
  t.click(103);
  assert.equal(t.settled(104), null);
  // Within 20 s of the last request a settled click is quiet.
  t.click(110);
  assert.deepEqual(t.settled(110.5), { kind: 'quiet' });
  t.click(121);
  assert.deepEqual(t.settled(121.5), { kind: 'ask', count: 4 });
  for (let i = 0; i < 30; i += 1) t.click(200 + i);
  t.click(240);
  assert.deepEqual(t.settled(241), { kind: 'ask', count: 20 }, 'agentd takes up to 20');
});

test('RitualTap: a double click takes back its first half', () => {
  const t = new RitualTap();
  t.click(100);
  t.doubleClick();
  assert.equal(t.settled(101), null);
  t.click(110);
  assert.deepEqual(t.settled(111), { kind: 'ask', count: 1 });
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
    [409, { while: 'working' }, '她在忙，等这一轮做完', '她在忙，等这一轮做完'],
    [409, { while: 'speaking' }, null, '她正在说话，稍后再试'],
    [409, { error: 'switching' }, '角色正在切换，稍后再试', '角色正在切换，稍后再试'],
    [503, { error: 'no_llm' }, '角色内核未就绪', '角色内核未就绪'],
    [200, {}, null, '这次没有可播放的回应'],
    [503, { error: 'other' }, '没能收到角色回应，稍后再试', '没能收到角色回应，稍后再试'],
    [0, null, '没能收到角色回应，稍后再试', '没能收到角色回应，稍后再试'],
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
