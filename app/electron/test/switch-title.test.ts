// 雷霆大字 (src/main/title/overlay.ts): the title window over her screen while a character switch runs, from its start until
// the avatar shows the new character, fed the switch's views as index.ts feeds it, over fake windows; and its 设置 row's key.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { parseChanges, planSave, schema } from '../src/common/settings.ts';
import { CharacterSwitch, type SwitchPorts } from '../src/common/switch.ts';
import { OVERLAY_LEVELS } from '../src/main/platform/index.ts';
import { TITLE_MAX_MS, TITLE_MIN_MS, TitleOverlay, titleNames, titleScreen } from '../src/main/title/overlay.ts';

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

type Handler = (...args: unknown[]) => void;

/** A BrowserWindow in miniature: what the overlay calls on it, recorded; `load` fires its page's did-finish-load. */
function fakeWindow(n: number) {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  let destroyed = false;
  const win = {
    webContents: { once: (name: string, fn: Handler) => handlers.set(name, fn) },
    isDestroyed: () => destroyed,
    loadURL: async (url: string) => { calls.push(`load ${url}`); },
    setBounds: (b: { x: number; y: number; width: number; height: number }) => calls.push(`bounds ${b.x},${b.y} ${b.width}x${b.height}`),
    showInactive: () => calls.push('showInactive'),
    destroy: () => {
      destroyed = true;
      calls.push('destroy');
    },
  };
  return { n, win: win as unknown as BrowserWindow, calls, load: () => handlers.get('did-finish-load')?.() };
}

const HER = { id: 2, frame: { x: 1440, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1440, y: 0, w: 1920, h: 1055 } };
const MAIN = { id: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 0, w: 1440, h: 875 } };

function setup() {
  /** agentd's commit answers when `commit.open` is called; open until a test holds it. */
  const commit = { held: false, open: () => {}, };
  const ports: SwitchPorts = {
    agentdRunning: () => true,
    prepare: async (id) => ({ kind: 'prepared', switchId: id }),
    commit: () => commit.held ? new Promise((r) => { commit.open = () => r({ kind: 'committed' }); }) : Promise.resolve({ kind: 'committed' }),
    abort: async () => ({ kind: 'aborted' }),
    setAgentdCharacter: async () => ({ kind: 'changed', changed: true }),
    readAgentd: async () => null,
    setCharacter: () => true, restartAvatar: () => {}, persist: () => {}, renderable: () => true, log: () => {},
  };
  const sw = new CharacterSwitch(ports);
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const state = { on: true, current: '2' as string | null };
  const title = new TitleOverlay({
    url: 'agentic-complex-ui://app/stack.html#/title',
    makeWindow: () => {
      const w = fakeWindow(windows.length);
      windows.push(w);
      return w.win;
    },
    // The main screen 900 high, y up.
    toDip: (r) => ({ x: r.x, y: 900 - (r.y + r.h), width: r.w, height: r.h }),
    screen: () => titleScreen(state.current, [MAIN, HER]),
    names: (id) => ({ a: { name: '佩丽卡', en: 'Perlica' }, b: { name: '管理员', en: '' } } as Record<string, { name: string; en: string }>)[id]
      ?? { name: id, en: '' },
    enabled: () => state.on,
  });
  sw.onChange = (v) => title.view(v);
  /** Switches to `id` and lets the avatar answer `reply`. */
  const to = async (id: string, reply: 'changed' | 'failed' = 'changed') => {
    sw.select(id);
    await settle();
    sw.avatar(reply === 'changed' ? { kind: 'changed', id } : { kind: 'failed', id, reason: 'no_such_character' });
    await settle();
  };
  return { sw, title, windows, state, to, commit };
}

test('the title opens as a switch starts, with the new character\'s name, never at launch or on a reconnect', async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'b' });
  t.sw.agentdReported('b');
  await settle();
  assert.equal(t.windows.length, 0, 'the launch hello shows nothing');
  t.sw.avatar({ kind: 'current', id: 'b' });
  await settle();
  assert.equal(t.windows.length, 0, 'a reconnect to the same character shows nothing');
  t.sw.select('b');
  await settle();
  assert.equal(t.windows.length, 0, 'picking the character she is shows nothing');
  t.sw.select('a');
  assert.equal(t.windows.length, 1, 'open before the avatar has answered');
  assert.deepEqual(t.windows[0]!.calls, ['bounds 1440,-180 1920x1080',
    `load agentic-complex-ui://app/stack.html#/title?${new URLSearchParams({ name: '佩丽卡', en: 'Perlica' }).toString()}`]);
  await settle();
  t.sw.avatar({ kind: 'changed', id: 'a' });
  await settle();
  await t.to('b');
  assert.equal(t.windows.length, 2);
  assert.match(t.windows[1]!.calls[1]!, /#\/title\?name=%E7%AE%A1%E7%90%86%E5%91%98$/, 'no en without an English name');
});

/** Runs `body` with setTimeout and Date on a mock clock. */
async function clocked(body: () => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await body();
  } finally {
    mock.timers.reset();
  }
}

test('the title shows once its page has loaded, without taking the front app, and stays at least 4 s', () => clocked(async () => {
  assert.equal(TITLE_MIN_MS, 4000);
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'b' });
  t.commit.held = true;
  t.sw.select('a');
  await settle();
  const w = t.windows[0]!;
  assert.ok(!w.calls.includes('showInactive'), 'hidden until the page is there');
  w.load();
  assert.equal(w.calls.at(-1), 'showInactive');
  mock.timers.tick(1000);
  t.sw.avatar({ kind: 'changed', id: 'a' });
  await settle();
  assert.ok(!w.calls.includes('destroy'), 'she appeared 1 s after it showed: it stays');
  mock.timers.tick(2999);
  assert.ok(!w.calls.includes('destroy'));
  mock.timers.tick(1);
  assert.equal(w.calls.at(-1), 'destroy', 'gone 4 s after it showed, before agentd has committed');
  assert.equal(t.sw.busy, true);
  t.commit.open();
  await settle();
  assert.equal(t.windows.length, 1);
}));

test('once it has shown 4 s, the title closes as soon as she appears', () => clocked(async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'b' });
  t.sw.select('a');
  await settle();
  t.windows[0]!.load();
  mock.timers.tick(6000);
  t.sw.avatar({ kind: 'changed', id: 'a' });
  await settle();
  assert.equal(t.windows[0]!.calls.at(-1), 'destroy');
}));

test('a page that loads after she appeared still shows 4 s; a failed switch closes the title after its 4 s', () => clocked(async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'b' });
  await t.to('a');
  const late = t.windows[0]!;
  assert.ok(!late.calls.includes('destroy'));
  late.load();
  assert.equal(late.calls.at(-1), 'showInactive');
  mock.timers.tick(TITLE_MIN_MS);
  assert.equal(late.calls.at(-1), 'destroy');
  t.sw.select('c');
  await settle();
  t.windows[1]!.load();
  t.sw.avatar({ kind: 'failed', id: 'c', reason: 'no_such_character' });
  await settle();
  assert.ok(!t.windows[1]!.calls.includes('destroy'));
  mock.timers.tick(TITLE_MIN_MS);
  assert.equal(t.windows[1]!.calls.at(-1), 'destroy');
}));

test('a title whose page never loads, or whose switch never ends, goes 12 s after it opened', () => clocked(async () => {
  assert.equal(TITLE_MAX_MS, 12000);
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'b' });
  t.sw.select('a');
  await settle();
  mock.timers.tick(TITLE_MAX_MS - 1);
  assert.ok(!t.windows[0]!.calls.includes('destroy'));
  mock.timers.tick(1);
  assert.equal(t.windows[0]!.calls.at(-1), 'destroy', 'never loaded, never shown, gone');
  assert.ok(!t.windows[0]!.calls.includes('showInactive'));
  t.sw.avatar({ kind: 'changed', id: 'a' });
  await settle();
  t.sw.select('b');
  await settle();
  t.windows[1]!.load();
  mock.timers.tick(TITLE_MAX_MS);
  assert.equal(t.windows[1]!.calls.at(-1), 'destroy', 'shown, the avatar never answered, gone');
}));

test('a new switch picked while the title shows replaces it; with the setting off nothing shows', () => clocked(async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'b' });
  t.commit.held = true;
  t.sw.select('a');
  await settle();
  t.windows[0]!.load();
  t.sw.select('b');
  t.sw.avatar({ kind: 'changed', id: 'a' });
  await settle();
  t.commit.open();
  await settle();
  assert.equal(t.windows.length, 2, 'the kept choice opens its own title');
  assert.equal(t.windows[0]!.calls.at(-1), 'destroy', 'the showing one goes at once, its 4 s or not');
  assert.match(t.windows[1]!.calls[1]!, /name=%E7%AE%A1%E7%90%86%E5%91%98$/);
  t.windows[1]!.load();
  t.commit.held = false;
  t.sw.avatar({ kind: 'changed', id: 'b' });
  await settle();
  mock.timers.tick(TITLE_MIN_MS);
  t.state.on = false;
  await t.to('a');
  assert.equal(t.windows.length, 2);
  assert.equal(t.windows[1]!.calls.at(-1), 'destroy');
  t.title.stop();
}));

test('picking the character she is leaves nothing behind: a later run that is no choice opens no title', async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'a' });
  t.sw.agentdReported('a');
  t.sw.select('a');
  await settle();
  // The avatar comes back as another character: the run that brings agentd onto her is no choice.
  t.sw.avatar({ kind: 'current', id: 'b' });
  await settle();
  assert.equal(t.windows.length, 0);
});

test('a title closed while its page loads leaves no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const w = fakeWindow(0);
    let fail: (e: Error) => void = () => {};
    const win = w.win as unknown as { loadURL: () => Promise<void>; destroy: () => void };
    win.loadURL = () => new Promise((_r, reject) => { fail = reject; });
    const destroy = win.destroy;
    win.destroy = () => { destroy(); fail(new Error('ERR_FAILED (-2) loading')); };
    const title = new TitleOverlay({ url: 'agentic-complex-ui://app/stack.html#/title', makeWindow: () => w.win,
      toDip: (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }), screen: () => MAIN.frame, names: (id) => ({ name: id, en: '' }), enabled: () => true });
    const view = { current: 'b', shown: 'b', agentd: 'b', failure: null };
    title.view({ ...view, pending: 'a', switching: false });
    title.view({ ...view, pending: null, switching: true });
    title.stop();
    await settle();
    assert.equal(w.calls.at(-1), 'destroy');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the title stands over her window and under the stack and every overlay over it', () => {
  const L = OVERLAY_LEVELS;
  assert.ok(L.title > 0);
  for (const [name, level] of Object.entries(L)) if (!['bubble', 'chip', 'title'].includes(name)) assert.ok(level > L.title, name);
});

test('the title covers the screen she stands on, else the main screen', () => {
  assert.deepEqual(titleScreen('2', [MAIN, HER]), HER.frame);
  assert.deepEqual(titleScreen(null, [MAIN, HER]), MAIN.frame);
  assert.deepEqual(titleScreen('9', [MAIN, HER]), MAIN.frame);
  assert.equal(titleScreen(null, []), null);
});

test('the title\'s names come from the library\'s character.json: display.name zh-Hans and en', () => {
  const dir = mkdtempSync(join(tmpdir(), 'title-'));
  try {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'character.json'), JSON.stringify({ id: 'a', display: { name: { 'zh-Hans': '佩丽卡', en: 'Perlica' } } }));
    writeFileSync(join(dir, 'current.json'), JSON.stringify({ schema: 'endfield-character-library/v1',
      characters: [{ id: 'a', definition: { file: 'a/character.json' } }] }));
    assert.deepEqual(titleNames(join(dir, 'current.json'), 'a'), { name: '佩丽卡', en: 'Perlica' });
    assert.equal(titleNames(join(dir, 'current.json'), 'x'), null);
    assert.equal(titleNames(join(dir, 'missing.json'), 'a'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('切换角色时的雷霆大字: config.json switch_title, on by default, saved without a restart', () => {
  const row = schema('mac').find((r) => r.id === 'switchTitle');
  assert.deepEqual([row?.group, row?.kind, row?.default, row?.restart, row?.label], ['speak', 'toggle', true, 'none', '切换角色时的雷霆大字']);
  assert.deepEqual(parseChanges({ switchTitle: false }, () => {}), { switch_title: false });
  assert.deepEqual(planSave({}, null, { switch_title: false }), { write: { switch_title: false }, effects: [], restart: 'none' });
  assert.deepEqual(planSave({ switch_title: false }, null, { switch_title: true }), { write: { switch_title: true }, effects: [], restart: 'none' });
});
