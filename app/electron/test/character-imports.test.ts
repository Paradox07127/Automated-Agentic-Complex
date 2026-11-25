// `character.importMotion`, `importOutfit`, `removeOutfit` and `mmd.scan`, `importScan`, `setMedia` against a fake picker, fake
// tools and a fake link.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import type { Actions, AvatarHello } from '../src/common/c3.ts';
import { silentSource } from '../src/common/feed.ts';
import type { ImportProgress } from '../src/common/import-state.ts';
import { MmdSync } from '../src/common/mmd-sync.ts';
import { PageSession } from '../src/common/page.ts';
import { PushSource } from '../src/common/push.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { AvatarHost } from '../src/main/ops/avatar.ts';
import { characterOps, type ImportPicker, mmdOps } from '../src/main/ops/character.ts';
import type { OpsContext, ToolResult } from '../src/main/ops/context.ts';
import { runAgentdTool } from '../src/main/ops/tools.ts';

class Link implements AvatarHost {
  hello: AvatarHello | null = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['actions'] };
  companionCapabilities = ['actions'];
  hidden = false;
  currentCharacter: string | null = 'si';
  currentAppearance: string | null = 'mod_1';
  appearances = [{ id: 'default', name: '默认' }, { id: 'mod_1', name: '模组' }];
  layers = [];
  hiddenLayers = [];
  lastStats = null;
  lastPipeline = null;
  lastPlacement = null;
  setVisible() { return true; }
  stopSpeech() { return true; }
  async actions(): Promise<Actions> { return { v: 1, type: 'actions', character: 'si', switches: {}, actions: [] }; }
  async playAction() {}
  stopAction() {}
}

interface Fixture {
  dir: string; link: Link; calls: string[]; tools: string[][];
  switcher: { busy: boolean; held: boolean; switchOutcome(): Promise<never> };
  /** What the picker answers, in order; `files` and `folder` take the next one. */
  picks: (string[] | string | null)[];
  /** The options the picker was asked with. */
  asked: Record<string, unknown>[];
  tool: (script: string, args: string[], progress?: (p: ImportProgress) => void) => ToolResult | Promise<ToolResult>;
  /** `character.onImport`'s events, in order. */
  pushed: unknown[];
  /** `mmd.onSync`'s. */
  synced: unknown[];
  call(op: string, ...args: unknown[]): Promise<unknown>;
  done(): void;
}

function fixture(o: { catalog?: boolean; link?: boolean; host?: () => string; mmdSync?: OpsContext['mmdSync'] } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'imports-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  const link = new Link(), calls: string[] = [], tools: string[][] = [];
  const switcher = { busy: false, held: false, current: 'si', switchOutcome: async (): Promise<never> => { throw new Error('unused'); } };
  const f = { dir, link, calls, tools, switcher, picks: [], asked: [], pushed: [], synced: [],
    tool: () => ({ last: '', status: 1, stderr: 'no tool' }) } as unknown as Fixture;
  const picker: ImportPicker = {
    files: async (options) => {
      calls.push(`pick held=${switcher.held}`);
      f.asked.push({ ...options });
      const next = f.picks.shift();
      return Array.isArray(next) ? next : [];
    },
    folder: async (options) => {
      calls.push(`pick held=${switcher.held}`);
      f.asked.push({ ...options });
      const next = f.picks.shift();
      return typeof next === 'string' ? next : null;
    },
    filesOrFolder: async (options) => {
      calls.push(`pick held=${switcher.held}`);
      f.asked.push({ ...options });
      const next = f.picks.shift();
      return Array.isArray(next) ? next : [];
    },
  };
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null, store: null,
    diag: null, avatar: o.link === false ? null : link, switcher: o.link === false ? null : switcher, mmdSync: o.mmdSync,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }),
      restartAvatar: () => {
        calls.push(`restartAvatar held=${switcher.held}`);
        const hello = link.hello;
        link.hello = null;
        setTimeout(() => { link.hello = hello; }, 50);
      } },
    library: { catalog: o.catalog === false ? null : join(dir, 'library', 'current.json'), launched: 'si', characterName: 'Si',
      hookCommand: '', validationHost: o.host ?? (() => 'host-bin'), rosterChanged: () => {},
      runTool: async (script, args, progress) => {
        tools.push([script, ...args]);
        calls.push(`tool held=${switcher.held}`);
        return f.tool(script, args, progress);
      } },
    confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource,
    log: (line) => calls.push(`log ${line}`),
  };
  const ops = new Map(Object.entries({ ...characterOps(ctx, picker), ...mmdOps(ctx, picker, join(dir, 'scans')) }));
  const page = new PageSession((_id, stream, kind, payload) => {
    if (stream === 'character.onImport' && kind === 'event') f.pushed.push(JSON.parse(payload!.data));
    if (stream === 'mmd.onSync' && kind === 'event') f.synced.push(JSON.parse(payload!.data));
  });
  f.call = async (op, ...args) => {
    const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
    return reply.ok ? reply.value : { error: reply.error };
  };
  f.done = () => rmSync(dir, { recursive: true, force: true });
  return f;
}

const LIBRARY = (f: Fixture) => join(f.dir, 'library');
const MOTION_LINE = JSON.stringify({ ok: true, action: { id: 'mmd_dance_1', title: 'dance', duration_s: 12.5, has_bgm: true },
  format: 'vmd', warnings: ['ik_dropped'] });
const ACTION = { id: 'mmd_dance_1', title: 'dance', durationS: 12.5, hasBgm: true, format: 'vmd', warnings: ['ik_dropped'] };
const BUSY = { ok: false, reason: 'busy', detail: '角色正在切换，或另一个导入还没完成' };
const err = (code: string, detail: string) => ({ error: { code, detail } });

test('character.importMotion asks for the motion and a BGM while holding the switch, runs motion_tool import, restarts the renderer', async () => {
  const f = fixture();
  try {
    const dance = join(f.dir, 'dance.vmd'), song = join(f.dir, 'song.mp3');
    f.picks = [[dance], [song]];
    f.tool = () => ({ last: MOTION_LINE, status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.importMotion'), { ok: true, action: ACTION });
    assert.deepEqual(f.tools, [['motion_tool.py', 'import', '--library', LIBRARY(f), '--character', 'si', '--source', dance,
      '--bgm', song, '--validate-with', 'host-bin']]);
    assert.deepEqual(f.calls, ['pick held=true', 'pick held=true', 'tool held=true', 'restartAvatar held=true']);
    assert.equal(f.switcher.held, false);
    assert.deepEqual(f.asked.map((a) => [a.title, a.extensions, a.multiple]), [
      ['导入动作', ['vmd', 'bvh', 'glb', 'gltf', 'vrma', 'fbx', 'zip'], true],
      ['选择背景音乐', ['wav', 'mp3', 'm4a', 'aac', 'flac', 'aif', 'aiff'], false]]);
  } finally {
    f.done();
  }
});

test('character.importMotion: several files or a ZIP skip the BGM panel; a cancelled BGM panel imports without one', async () => {
  const f = fixture();
  try {
    f.tool = () => ({ last: MOTION_LINE, status: 0, stderr: '' });
    const a = join(f.dir, 'a.vmd'), zip = join(f.dir, 'pack.ZIP'), b = join(f.dir, 'b.vmd');
    f.picks = [[a, zip, b]];
    assert.deepEqual(await f.call('character.importMotion'), { ok: true, action: ACTION });
    f.picks = [[a], []];
    assert.deepEqual(await f.call('character.importMotion'), { ok: true, action: ACTION });
    assert.deepEqual(f.tools.map((t) => t.slice(6)), [
      ['--source', zip, '--extra', a, '--extra', b, '--validate-with', 'host-bin'],
      ['--source', a, '--validate-with', 'host-bin']]);
    assert.equal(f.asked.length, 3);
  } finally {
    f.done();
  }
});

test('character.importMotion: a cancelled panel is cancelled and runs nothing', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'cancelled' });
    assert.deepEqual(f.tools, []);
    assert.deepEqual(f.calls, ['pick held=true']);
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});

test('character.importMotion: a file of another type is unsupported_format and runs nothing', async () => {
  const f = fixture();
  try {
    f.picks = [[join(f.dir, 'dance.vmd'), join(f.dir, 'notes.txt')]];
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'unsupported_format', detail: 'notes.txt' });
    assert.deepEqual(f.tools, []);
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});

test('character.importMotion passes on motion_tool\'s failure line and does not restart the renderer', async () => {
  const f = fixture();
  try {
    f.picks = [[join(f.dir, 'a.vmd'), join(f.dir, 'b.vmd')]];
    f.tool = () => ({ last: '', status: 1, stderr: 'log\n{"reason": "bad_vmd", "detail": "header"}\n' });
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'bad_vmd', detail: 'header' });
    f.picks = [[join(f.dir, 'a.vmd'), join(f.dir, 'b.vmd')]];
    f.tool = () => ({ last: '{"ok": true}', status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.importMotion'),
      { ok: false, reason: 'internal', detail: 'motion_tool printed no result: {"ok": true}' });
    assert.deepEqual(f.calls.filter((c) => c.startsWith('restartAvatar')), []);
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});

test('character.importMotion: busy while switching or holding, internal without a character, a library or a host', async () => {
  const f = fixture();
  try {
    f.switcher.busy = true;
    assert.deepEqual(await f.call('character.importMotion'), BUSY);
    f.switcher.busy = false;
    f.switcher.held = true;
    assert.deepEqual(await f.call('character.importMotion'), BUSY);
    f.switcher.held = false;
    f.link.currentCharacter = null;
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'internal', detail: '角色还没连上' });
    assert.deepEqual(f.calls, []);
  } finally {
    f.done();
  }
  const bare = fixture({ catalog: false });
  try {
    assert.deepEqual(await bare.call('character.importMotion'), { ok: false, reason: 'internal', detail: '没有配置角色目录' });
  } finally {
    bare.done();
  }
  const unlinked = fixture({ link: false });
  try {
    assert.deepEqual(await unlinked.call('character.importMotion'), { ok: false, reason: 'internal', detail: '角色还没连上（配置出错）' });
  } finally {
    unlinked.done();
  }
  const hostless = fixture({ host: () => { throw new Error('未配置 Metal 宿主可执行文件'); } });
  try {
    hostless.picks = [[join(hostless.dir, 'a.vmd'), join(hostless.dir, 'b.vmd')]];
    assert.deepEqual(await hostless.call('character.importMotion'),
      { ok: false, reason: 'validate_failed', detail: '未配置 Metal 宿主可执行文件' });
    assert.deepEqual(hostless.tools, []);
  } finally {
    hostless.done();
  }
});

const SCANS = (f: Fixture) => join(f.dir, 'scans');
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1]!;

/** motion_tool mmd-scan as W-A prints it: two bodies, a face, a camera and the music in the folder it unpacks to. */
function scanLine(root: string) {
  const at = (name: string) => join(root, name);
  return JSON.stringify({
    ok: true, title: '愛包ダンスホール', root,
    bodies: [
      { path: at('a[f-19].vmd'), name: 'a[f-19].vmd', label: 'HimeTanaka', model: '田中ヒメ', duration_s: 223.33, place_frame: -19, has_morph: true },
      { path: at('b[f-19].vmd'), name: 'b[f-19].vmd', label: 'SuzukiHina', model: '鈴木ヒナ', duration_s: 220, place_frame: -19, has_morph: false },
    ],
    faces: [{ path: at('lip.vmd'), name: 'lip.vmd', duration_s: 210, morphs: 5 }],
    cameras: [{ path: at('cam.vmd'), name: 'cam.vmd', duration_s: 223, place_frame: null }],
    audio: [{ path: at('inst.wav'), name: 'inst.wav' }],
    ignored: [{ name: 'Readme.txt', reason: 'not_motion' }],
    suggested: { body: 0, face: 0, camera: 0, audio: 0, bgm_start_s: -0.633 },
  });
}

/** The fake motion_tool: mmd-scan makes its unpack folder and prints `scanLine`; import prints an action named by its title. */
function scanTool(f: Fixture, fail: (args: string[]) => string | null = () => null) {
  f.tool = (_script, args) => {
    if (args[0] === 'mmd-scan') {
      mkdirSync(arg(args, '--unpack-to'));
      return { last: scanLine(arg(args, '--unpack-to')), status: 0, stderr: '' };
    }
    const failure = fail(args);
    if (failure !== null) return { last: '', status: 1, stderr: failure };
    const title = args.find((a) => a.startsWith('--title='))!.slice(8);
    return { last: JSON.stringify({ ok: true, action: { id: `mmd_${title.length}`, title, duration_s: 220, has_bgm: true } }), status: 0, stderr: '' };
  };
}

const imported = (title: string) => ({ id: `mmd_${title.length}`, title, durationS: 220, hasBgm: true, format: 'vmd', warnings: [] });

test('mmd.scan asks for files or a folder without holding the switch, scans into a fresh folder under the scan root, answers in camelCase', async () => {
  const f = fixture();
  try {
    scanTool(f);
    const pack = join(f.dir, '愛包ダンスホール');
    f.picks = [[pack, join(f.dir, 'inst.wav')]];
    const reply = await f.call('mmd.scan', { folder: false }) as { ok: true; token: string; scan: Record<string, unknown> };
    assert.equal(reply.ok, true);
    assert.equal(typeof reply.token, 'string');
    const unpack = arg(f.tools[0]!, '--unpack-to');
    assert.deepEqual(f.tools[0], ['motion_tool.py', 'mmd-scan', '--source', pack, '--extra', join(f.dir, 'inst.wav'), '--unpack-to', unpack]);
    assert.equal(dirname(unpack), SCANS(f));
    assert.deepEqual(reply.scan.suggested, { body: 0, face: 0, camera: 0, audio: 0, bgmStartS: -0.633 });
    assert.deepEqual((reply.scan.bodies as unknown[])[0], { path: join(unpack, 'a[f-19].vmd'), name: 'a[f-19].vmd', label: 'HimeTanaka',
      model: '田中ヒメ', durationS: 223.33, placeFrame: -19, hasMorph: true });
    assert.deepEqual(f.calls, ['pick held=false', 'tool held=false']);
    assert.deepEqual(f.asked, [{ title: '导入 MMD', message: '选择 MMD 工程的文件夹、ZIP，或 VMD 和音频文件；可多选',
      extensions: ['vmd', 'zip', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'aif', 'aiff'], folder: false }]);
    f.picks = [[pack]];
    await f.call('mmd.scan', { folder: true });
    assert.equal(f.asked[1]!.folder, true);
  } finally {
    f.done();
  }
});

test('mmd.scan keeps one scan: a new scan or mmd.dropScan deletes the folder of the one before; another token drops nothing', async () => {
  const f = fixture();
  try {
    scanTool(f);
    f.picks = [[join(f.dir, 'a.zip')], [join(f.dir, 'b.zip')]];
    const first = await f.call('mmd.scan', { folder: false }) as { token: string };
    const one = arg(f.tools[0]!, '--unpack-to');
    assert.equal(existsSync(one), true);
    const second = await f.call('mmd.scan', { folder: false }) as { token: string };
    const two = arg(f.tools[1]!, '--unpack-to');
    assert.notEqual(second.token, first.token);
    assert.notEqual(two, one);
    assert.deepEqual([existsSync(one), existsSync(two)], [false, true]);
    assert.equal(await f.call('mmd.dropScan', first.token), null);
    assert.equal(existsSync(two), true);
    assert.equal(await f.call('mmd.dropScan', second.token), null);
    assert.deepEqual(readdirSync(SCANS(f)), []);
    assert.deepEqual(await f.call('mmd.importScan', { token: second.token, items: [{ body: 0, title: 'x' }], face: null, camera: null,
      audio: null, bgmStartS: null, project: 'x' }), { ok: false, reason: 'scan_gone', detail: '识别结果已失效，请重新导入', actions: [] });
  } finally {
    f.done();
  }
});

test('mmd.scan: a cancelled panel runs nothing; a failed scan deletes its folder and passes on the reason; a missing component asks nothing', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.call('mmd.scan', { folder: false }), { ok: false, reason: 'cancelled' });
    assert.deepEqual(f.tools, []);
    f.picks = [[join(f.dir, 'a.zip')]];
    f.tool = (_script, args) => {
      mkdirSync(arg(args, '--unpack-to'));
      return { last: '', status: 1, stderr: '{"reason": "bad_vmd", "detail": "no body motion"}\n' };
    };
    assert.deepEqual(await f.call('mmd.scan', { folder: false }), { ok: false, reason: 'bad_vmd', detail: 'no body motion' });
    assert.deepEqual(readdirSync(SCANS(f)), []);
    assert.deepEqual(await f.call('mmd.scan', 'x'), err('bad_args', 'mmd.scan'));
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ missing_components: { 'runtime.python': 'componentMissing' } }));
    assert.deepEqual(await f.call('mmd.scan', { folder: false }), { ok: false, reason: 'internal', detail: '缺 runtime.python 组件' });
    assert.equal(f.asked.length, 2);
  } finally {
    f.done();
  }
});

const PLAN = { items: [{ body: 0, title: '愛包 · HimeTanaka' }, { body: 1, title: '愛包 · SuzukiHina' }], face: 0, camera: 0, audio: 0,
  bgmStartS: -0.633, project: '愛包ダンスホール' };

test('mmd.importScan imports each body in turn with the chosen face, camera, music and offset, restarts her once, then drops the scan', async () => {
  const f = fixture();
  try {
    scanTool(f);
    await f.call('character.onImport', 1);
    f.picks = [[join(f.dir, 'pack.zip')]];
    const { token } = await f.call('mmd.scan', { folder: false }) as { token: string };
    const unpack = arg(f.tools[0]!, '--unpack-to');
    f.calls.length = 0;
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token }),
      { ok: true, actions: [imported('愛包 · HimeTanaka'), imported('愛包 · SuzukiHina')] });
    const tail = ['--morph', join(unpack, 'lip.vmd'), '--camera', join(unpack, 'cam.vmd'), '--bgm', join(unpack, 'inst.wav'), '--bgm-start=-0.633'];
    assert.deepEqual(f.tools.slice(1), [
      ['motion_tool.py', 'import', '--library', LIBRARY(f), '--character', 'si', '--source', join(unpack, 'a[f-19].vmd'), ...tail,
        '--title=愛包 · HimeTanaka', '--project=愛包ダンスホール', '--role=HimeTanaka', '--validate-with', 'host-bin'],
      ['motion_tool.py', 'import', '--library', LIBRARY(f), '--character', 'si', '--source', join(unpack, 'b[f-19].vmd'), ...tail,
        '--title=愛包 · SuzukiHina', '--project=愛包ダンスホール', '--role=SuzukiHina', '--validate-with', 'host-bin']]);
    assert.deepEqual(f.calls, ['tool held=true', 'tool held=true', 'restartAvatar held=true']);
    assert.equal(f.switcher.held, false);
    assert.deepEqual(f.pushed.map((p) => [(p as { kind: string }).kind, (p as { title: string }).title, (p as { stage: string }).stage]), [
      ['mmd', '愛包 · HimeTanaka', null], ['mmd', '愛包 · HimeTanaka', 'reload'], [null, null, null],
      ['mmd', '愛包 · SuzukiHina', null], ['mmd', '愛包 · SuzukiHina', 'reload'], [null, null, null]]);
    assert.equal(existsSync(unpack), false);
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token }), { ok: false, reason: 'scan_gone', detail: '识别结果已失效，请重新导入',
      actions: [] });
  } finally {
    f.done();
  }
});

test('mmd.importScan stops at the first failure and reports it with the ones already done; she restarts only when one was', async () => {
  const f = fixture();
  try {
    let failing = '--role=HimeTanaka';
    scanTool(f, (args) => (args.includes(failing) ? '{"reason": "too_long", "detail": "361 s"}\n' : null));
    f.picks = [[join(f.dir, 'pack.zip')]];
    let { token } = await f.call('mmd.scan', { folder: false }) as { token: string };
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token }), { ok: false, reason: 'too_long', detail: '361 s', actions: [] });
    assert.equal(f.tools.length, 2, 'the second body is not tried');
    assert.deepEqual(f.calls.filter((c) => c.startsWith('restartAvatar')), []);
    assert.deepEqual(readdirSync(SCANS(f)), []);
    failing = '--role=SuzukiHina';
    f.picks = [[join(f.dir, 'pack.zip')]];
    ({ token } = await f.call('mmd.scan', { folder: false }) as { token: string });
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token }),
      { ok: false, reason: 'too_long', detail: '361 s', actions: [imported('愛包 · HimeTanaka')] });
    assert.deepEqual(f.calls.filter((c) => c.startsWith('restartAvatar')), ['restartAvatar held=true']);
    assert.deepEqual(readdirSync(SCANS(f)), []);
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});

test('mmd.importScan: a plan that does not fit the scan is bad_args and keeps it; busy while switching keeps it too', async () => {
  const f = fixture();
  try {
    scanTool(f);
    f.picks = [[join(f.dir, 'pack.zip')]];
    const { token } = await f.call('mmd.scan', { folder: false }) as { token: string };
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token, face: 3 }), err('bad_args', 'mmd.importScan'));
    f.switcher.busy = true;
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token }), { ...BUSY, actions: [] });
    f.switcher.busy = false;
    assert.equal(f.tools.length, 1);
    assert.equal((await f.call('mmd.importScan', { ...PLAN, token }) as { ok: boolean }).ok, true);
  } finally {
    f.done();
  }
});

test('mmd.pickScanAudio adds music from outside the scan once, and mmd.importScan of its index sends that file as the bgm', async () => {
  const f = fixture();
  try {
    scanTool(f);
    f.picks = [[join(f.dir, 'pack.zip')]];
    const { token, scan } = await f.call('mmd.scan', { folder: false }) as { token: string; scan: { audio: unknown[] } };
    const song = join(f.dir, 'elsewhere', 'off vocal.wav');
    f.picks = [[song], [song]];
    const audio = [...scan.audio, { path: song, name: 'off vocal.wav' }];
    const picked = await f.call('mmd.pickScanAudio', token) as { ok: true; scan: { audio: unknown[] }; audio: number };
    assert.deepEqual([picked.ok, picked.scan.audio, picked.audio], [true, audio, 1]);
    assert.deepEqual(f.asked.at(-1), { title: '选择音源', message: '和这支舞一起播放的音频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'aif', 'aiff'],
      multiple: false });
    const again = await f.call('mmd.pickScanAudio', token) as { scan: { audio: unknown[] }; audio: number };
    assert.deepEqual([again.scan.audio, again.audio], [audio, 1]);
    assert.equal((await f.call('mmd.importScan', { ...PLAN, items: [PLAN.items[0]], token, audio: 1 }) as { ok: boolean }).ok, true);
    assert.equal(arg(f.tools[1]!, '--bgm'), song);
  } finally {
    f.done();
  }
});

test('mmd.pickScanAudio: a cancelled panel is cancelled and keeps the list; another token is scan_gone and asks nothing; no token is bad_args', async () => {
  const f = fixture();
  try {
    scanTool(f);
    f.picks = [[join(f.dir, 'pack.zip')]];
    const { token } = await f.call('mmd.scan', { folder: false }) as { token: string };
    assert.deepEqual(await f.call('mmd.pickScanAudio', token), { ok: false, reason: 'cancelled' });
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token, audio: 1 }), err('bad_args', 'mmd.importScan'));
    const asked = f.asked.length;
    assert.deepEqual(await f.call('mmd.pickScanAudio', 'other'), { ok: false, reason: 'scan_gone', detail: '识别结果已失效，请重新导入' });
    assert.equal(f.asked.length, asked);
    assert.deepEqual(await f.call('mmd.pickScanAudio', 1), err('bad_args', 'mmd.pickScanAudio'));
  } finally {
    f.done();
  }
});

const MEDIA_LINE = JSON.stringify({ ok: true, action: { id: 'mmd_2', title: '愛包', duration_s: 223.3, has_bgm: true }, replaced: 'mmd_1' });

test('mmd.setMedia picks the music while holding the switch, runs mmd-media with the offset, restarts her; none runs --no-bgm', async () => {
  const f = fixture();
  try {
    f.tool = () => ({ last: MEDIA_LINE, status: 0, stderr: '' });
    const song = join(f.dir, 'off vocal.wav');
    f.picks = [[song]];
    const changed = { ok: true, action: { id: 'mmd_2', title: '愛包', durationS: 223.3, hasBgm: true, format: 'vmd', warnings: [] }, replaced: 'mmd_1' };
    assert.deepEqual(await f.call('mmd.setMedia', 'mmd_1', { bgm: 'pick', bgmStartS: -0.633 }), changed);
    assert.deepEqual(f.asked, [{ title: '选择音源', message: '和这支舞一起播放的音频',
      extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'aif', 'aiff'], multiple: false }]);
    assert.deepEqual(f.calls, ['pick held=true', 'tool held=true', 'restartAvatar held=true']);
    assert.deepEqual(await f.call('mmd.setMedia', 'mmd_1', { bgm: 'none', bgmStartS: null }), changed);
    assert.deepEqual(f.tools, [
      ['motion_tool.py', 'mmd-media', '--library', LIBRARY(f), '--character', 'si', '--action', 'mmd_1', '--bgm', song, '--bgm-start=-0.633',
        '--validate-with', 'host-bin'],
      ['motion_tool.py', 'mmd-media', '--library', LIBRARY(f), '--character', 'si', '--action', 'mmd_1', '--no-bgm', '--validate-with', 'host-bin']]);
    assert.equal(f.asked.length, 1);
    assert.deepEqual(await f.call('mmd.setMedia', 'mmd_1', { bgm: 'pick', bgmStartS: 0 }), { ok: false, reason: 'cancelled' });
    f.tool = () => ({ last: '', status: 1, stderr: '{"reason": "unknown_action", "detail": "mmd_1"}' });
    assert.deepEqual(await f.call('mmd.setMedia', 'mmd_1', { bgm: 'none', bgmStartS: null }), { ok: false, reason: 'unknown_action', detail: 'mmd_1' });
    for (const [id, media] of [['', { bgm: 'none', bgmStartS: null }], ['mmd_1', { bgm: 'x', bgmStartS: null }], ['mmd_1', { bgm: 'none', bgmStartS: '1' }]]) {
      assert.deepEqual(await f.call('mmd.setMedia', id, media), err('bad_args', 'mmd.setMedia'));
    }
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});

test('character.importOutfit asks for the mod folder while holding the switch, runs outfit_tool import, restarts the renderer', async () => {
  const f = fixture();
  try {
    const mod = join(f.dir, 'Red Coat');
    f.picks = [mod];
    f.tool = () => ({ last: JSON.stringify({ ok: true, appearance: { id: 'mod_1a2b', name: 'Red Coat' }, warnings: ['texture_unbound:a.dds'] }),
      status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.importOutfit'),
      { ok: true, appearance: { id: 'mod_1a2b', name: 'Red Coat' }, warnings: ['texture_unbound:a.dds'] });
    assert.deepEqual(f.tools, [['outfit_tool.py', 'import', '--library', LIBRARY(f), '--character', 'si', '--source', mod,
      '--validate-with', 'host-bin']]);
    assert.deepEqual(f.calls, ['pick held=true', 'tool held=true', 'restartAvatar held=true']);
    assert.equal(f.asked[0]!.title, '导入外观（EFMI mod）');
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});

test('character.importOutfit rejects with cancelled, outfit_tool\'s reason after the folder name, busy and internal', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.call('character.importOutfit'), err('cancelled', 'character.importOutfit'));
    f.picks = [join(f.dir, 'Red Coat')];
    f.tool = () => ({ last: '', status: 1, stderr: '{"reason": "texture_mismatch", "detail": "texture_mismatch:body:x"}' });
    assert.deepEqual(await f.call('character.importOutfit'), err('texture_mismatch', 'Red Coat: texture_mismatch:body:x'));
    f.picks = [join(f.dir, 'Red Coat')];
    f.tool = () => ({ last: '', status: 1, stderr: 'Traceback\n  boom\n' });
    assert.deepEqual(await f.call('character.importOutfit'), err('internal', 'Red Coat: Traceback\n  boom'));
    f.picks = [join(f.dir, 'Red Coat')];
    f.tool = () => ({ last: 'done', status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.importOutfit'), err('internal', 'outfit_tool printed no result: done'));
    assert.deepEqual(f.calls.filter((c) => c.startsWith('restartAvatar')), []);
    f.switcher.busy = true;
    assert.deepEqual(await f.call('character.importOutfit'), err('busy', '角色正在切换，或另一个导入还没完成'));
    assert.equal(f.asked.length, 4);
  } finally {
    f.done();
  }
  const bare = fixture({ catalog: false });
  try {
    assert.deepEqual(await bare.call('character.importOutfit'), err('internal', '没有配置角色目录'));
  } finally {
    bare.done();
  }
});

test('character.removeOutfit runs outfit_tool remove, moves a remembered look on it to her first appearance, restarts', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ last_appearance: { si: 'mod_1', cedar: 'mod_1' } }));
    f.tool = () => ({ last: '{"ok": true}', status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.removeOutfit', 'si', 'mod_1'), { ok: true, appearance: { id: 'mod_1' } });
    assert.deepEqual(f.tools, [['outfit_tool.py', 'remove', '--library', LIBRARY(f), '--character', 'si', '--appearance', 'mod_1',
      '--validate-with', 'host-bin']]);
    assert.deepEqual(f.calls, ['tool held=true', 'restartAvatar held=true']);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).last_appearance, { si: 'default', cedar: 'mod_1' });
    assert.deepEqual(await f.call('character.removeOutfit', 'si', 'mod_2'), { ok: true, appearance: { id: 'mod_2' } });
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).last_appearance, { si: 'default', cedar: 'mod_1' });
  } finally {
    f.done();
  }
});

test('character.removeOutfit: bad_args for a bad id, outfit_tool\'s reason, busy, internal without a library', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.call('character.removeOutfit', 'si', ''), err('bad_args', 'character.removeOutfit'));
    assert.deepEqual(await f.call('character.removeOutfit', 'si', 'x'.repeat(65)), err('bad_args', 'character.removeOutfit'));
    f.tool = () => ({ last: '', status: 1, stderr: '{"reason": "not_imported", "detail": "default"}' });
    assert.deepEqual(await f.call('character.removeOutfit', 'si', 'default'), err('not_imported', 'default'));
    assert.deepEqual(f.calls.filter((c) => c.startsWith('restartAvatar')), []);
    f.switcher.held = true;
    assert.deepEqual(await f.call('character.removeOutfit', 'si', 'mod_1'), err('busy', '角色正在切换，或另一个导入还没完成'));
    assert.equal(f.tools.length, 1);
  } finally {
    f.done();
  }
  const bare = fixture({ catalog: false });
  try {
    assert.deepEqual(await bare.call('character.removeOutfit', 'si', 'mod_1'), err('internal', '没有配置角色目录'));
  } finally {
    bare.done();
  }
});

const IDLE = { running: false, kind: null, title: null, stage: null, fraction: 0 };
const state = (kind: string, title: string, stage: string | null, fraction: number) => ({ running: true, kind, title, stage, fraction });

test('character.importMotion reports the source\'s name, each progress line that moves the bar and the reload, then idle', async () => {
  const f = fixture();
  try {
    assert.equal(await f.call('character.onImport', 1), null);
    assert.deepEqual(f.pushed, []);
    const zip = join(f.dir, 'dance.v2.ZIP');
    f.picks = [[join(f.dir, 'a.vmd'), zip]];
    const during: unknown[] = [];
    f.tool = async (_script, _args, progress) => {
      during.push(await f.call('character.importState'));
      progress!({ stage: 'read', fraction: 0 });
      progress!({ stage: 'read', fraction: 0.004 });
      progress!({ stage: 'retarget', fraction: 0.4 });
      during.push(await f.call('character.importState'));
      return { last: MOTION_LINE, status: 0, stderr: '' };
    };
    assert.deepEqual(await f.call('character.importMotion'), { ok: true, action: ACTION });
    assert.deepEqual(during, [state('motion', 'dance.v2', null, 0), state('motion', 'dance.v2', 'retarget', 0.4)]);
    assert.deepEqual(f.pushed, [state('motion', 'dance.v2', null, 0), state('motion', 'dance.v2', 'read', 0),
      state('motion', 'dance.v2', 'retarget', 0.4), state('motion', 'dance.v2', 'reload', 1), IDLE]);
    assert.deepEqual(await f.call('character.importState'), IDLE);
  } finally {
    f.done();
  }
});

test('mmd.setMedia and character.importOutfit report as mmd and outfit; outfit\'s title is the folder\'s whole name', async () => {
  const f = fixture();
  try {
    await f.call('character.onImport', 1);
    f.picks = [[join(f.dir, 'walk.wav')], join(f.dir, 'Red.Coat')];
    f.tool = (script, _args, progress) => {
      progress!({ stage: 'publish', fraction: 0.9 });
      return script === 'outfit_tool.py'
        ? { last: JSON.stringify({ ok: true, appearance: { id: 'mod_1a2b', name: 'Red Coat' } }), status: 0, stderr: '' }
        : { last: JSON.stringify({ ok: true, action: { id: 'mmd_2', title: 'dance', duration_s: 12.5, has_bgm: true }, replaced: 'mmd_1' }),
          status: 0, stderr: '' };
    };
    assert.equal((await f.call('mmd.setMedia', 'mmd_1', { bgm: 'pick', bgmStartS: null }) as { ok: boolean }).ok, true);
    assert.equal((await f.call('character.importOutfit') as { ok: boolean }).ok, true);
    assert.deepEqual(f.pushed, [state('mmd', 'walk', null, 0), state('mmd', 'walk', 'publish', 0.9), state('mmd', 'walk', 'reload', 1), IDLE,
      state('outfit', 'Red.Coat', null, 0), state('outfit', 'Red.Coat', 'publish', 0.9), state('outfit', 'Red.Coat', 'reload', 1), IDLE]);
  } finally {
    f.done();
  }
});

test('a failed import goes idle without the reload; a cancelled panel or a busy switch reports nothing; a new subscriber gets the last state', async () => {
  const f = fixture();
  try {
    await f.call('character.onImport', 1);
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'cancelled' });
    f.switcher.busy = true;
    assert.deepEqual(await f.call('character.importOutfit'), err('busy', '角色正在切换，或另一个导入还没完成'));
    f.switcher.busy = false;
    assert.deepEqual(f.pushed, []);
    f.picks = [join(f.dir, 'Red Coat')];
    f.tool = (_script, _args, progress) => {
      progress!({ stage: 'read', fraction: 0.1 });
      return { last: '', status: 1, stderr: '{"reason": "texture_mismatch", "detail": "x"}' };
    };
    assert.deepEqual(await f.call('character.importOutfit'), err('texture_mismatch', 'Red Coat: x'));
    assert.deepEqual(f.pushed, [state('outfit', 'Red Coat', null, 0), state('outfit', 'Red Coat', 'read', 0.1), IDLE]);
    await f.call('character.onImport', 2);
    assert.deepEqual(f.pushed.slice(3), [IDLE]);
  } finally {
    f.done();
  }
});

test('character.removeOutfit reports no progress', async () => {
  const f = fixture();
  try {
    await f.call('character.onImport', 1);
    f.tool = (_script, _args, progress) => {
      assert.equal(progress, undefined);
      return { last: '{"ok": true}', status: 0, stderr: '' };
    };
    assert.deepEqual(await f.call('character.removeOutfit', 'si', 'mod_1'), { ok: true, appearance: { id: 'mod_1' } });
    assert.deepEqual(f.pushed, []);
  } finally {
    f.done();
  }
});

test('a missing agentd or runtime.python component fails the imports before their panels', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ missing_components: { renderer: 'componentMissing',
      'runtime.python': 'componentMissing' } }));
    const missing = '缺 runtime.python 组件';
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'internal', detail: missing });
    assert.deepEqual(await f.call('mmd.setMedia', 'mmd_1', { bgm: 'pick', bgmStartS: null }), { ok: false, reason: 'internal', detail: missing });
    assert.deepEqual(await f.call('character.importOutfit'), err('internal', missing));
    assert.deepEqual(await f.call('character.importPackage'), { ok: false, reason: `角色包导入失败：${missing}` });
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ missing_components: { agentd: 'lockInvalid', 'runtime.python': 'componentMissing' } }));
    assert.deepEqual(await f.call('character.importOutfit'), err('internal', '缺 agentd 组件'));
    assert.deepEqual(f.asked, []);
    assert.deepEqual(f.tools, []);
    assert.equal(f.switcher.held, false);
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ missing_components: { renderer: 'componentMissing' } }));
    assert.deepEqual(await f.call('character.importMotion'), { ok: false, reason: 'cancelled' });
    assert.equal(f.asked.length, 1);
  } finally {
    f.done();
  }
});

test('a fake tool\'s progress lines reach character.onImport in order through runAgentdTool', async () => {
  const f = fixture();
  try {
    const lines = ['read', 'retarget', 'publish'].map((stage, i) => JSON.stringify({ event: 'progress', stage, fraction: i / 2 }));
    writeFileSync(join(f.dir, 'motion_tool.py'), `process.stdout.write(${JSON.stringify([...lines, MOTION_LINE].join('\n') + '\n')});\n`);
    f.tool = (script, args, progress) => runAgentdTool(process.execPath, [], f.dir, script, args, progress);
    await f.call('character.onImport', 1);
    f.picks = [[join(f.dir, 'a.vmd'), join(f.dir, 'b.vmd')]];
    assert.deepEqual(await f.call('character.importMotion'), { ok: true, action: ACTION });
    assert.deepEqual(f.pushed, [state('motion', 'a', null, 0), state('motion', 'a', 'read', 0), state('motion', 'a', 'retarget', 0.5),
      state('motion', 'a', 'publish', 1), state('motion', 'a', 'reload', 1), IDLE]);
  } finally {
    f.done();
  }
});

/** A sync of `si` that runs until `end`; the shell's object as index.ts hands it to the ops. */
function baking() {
  let end: () => void = () => {};
  const events = new PushSource('sync');
  const sync = new MmdSync({
    run: () => new Promise((resolve) => { end = () => resolve({ character: 'si', version: '1.0.0', baked: [], renamed: [], removed: [], failed: [] }); }),
    reload: async () => {}, current: () => 'si', send: (s) => events.send(s), log: () => {},
  });
  return { mmd: { sync, events }, start: () => sync.follow('si'), end: () => end() };
}

test('while the shared MMD library bakes, the motion imports, mmd.importScan, setMedia, renameMotion and removeMotion are busy and run nothing', async () => {
  const b = baking();
  const f = fixture({ mmdSync: b.mmd });
  try {
    assert.deepEqual(await f.call('mmd.syncState'), { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 });
    assert.equal(await f.call('mmd.onSync', 1), null);
    const done = b.start();
    await new Promise((r) => setImmediate(r));
    const running = { running: true, character: 'si', total: 0, done: 0, failed: 0, stage: null, fraction: 0 };
    assert.deepEqual(await f.call('mmd.syncState'), running);
    assert.deepEqual(f.synced, [running]);
    const SYNCING = { ok: false, reason: 'busy', detail: '正在给角色烘共享库里的 MMD 动作' };
    f.picks = [[join(f.dir, 'dance.vmd')]];
    assert.deepEqual(await f.call('character.importMotion'), SYNCING);
    assert.deepEqual(await f.call('mmd.importScan', { ...PLAN, token: 'x' }), { ...SYNCING, actions: [] });
    assert.deepEqual(await f.call('mmd.setMedia', 'mmd_1', { bgm: 'pick', bgmStartS: null }), SYNCING);
    assert.deepEqual(await f.call('character.renameMotion', 'si', 'm', '慢舞'), SYNCING);
    assert.deepEqual(await f.call('character.removeMotion', 'si', 'm'), SYNCING);
    assert.deepEqual(f.tools, []);
    assert.deepEqual(f.asked, [], 'no panel opens');
    assert.equal(f.switcher.held, false);
    b.end();
    await done;
    assert.deepEqual(f.synced.at(-1), { ...running, running: false, character: null });
    f.tool = () => ({ last: JSON.stringify({ id: 'm', title: '慢舞' }), status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.renameMotion', 'si', 'm', '慢舞'), { ok: true, id: 'm', title: '慢舞' });
  } finally {
    f.done();
  }
});

test('character.renameMotion and removeMotion restart the renderer while holding the switch and answer once she is back', async () => {
  const f = fixture();
  try {
    f.tool = (_script, args) => ({ last: JSON.stringify({ id: 'm', title: args.find((a) => a.startsWith('--title='))?.slice(8) }), status: 0, stderr: '' });
    assert.deepEqual(await f.call('character.renameMotion', 'si', 'm', '慢舞'), { ok: true, id: 'm', title: '慢舞' });
    assert.deepEqual(f.calls, ['tool held=true', 'restartAvatar held=true']);
    assert.notEqual(f.link.hello, null, 'the reply waits for her new hello');
    assert.deepEqual(await f.call('character.removeMotion', 'si', 'm'), { ok: true, id: 'm' });
    assert.deepEqual(f.calls.slice(2), ['tool held=true', 'restartAvatar held=true']);
    assert.notEqual(f.link.hello, null);
    f.tool = () => ({ last: '', status: 1, stderr: '{"reason": "unknown_action", "detail": "m"}\n' });
    assert.deepEqual(await f.call('character.removeMotion', 'si', 'm'), { ok: false, reason: 'unknown_action', detail: 'm' });
    assert.deepEqual(f.calls.slice(4), ['tool held=true'], 'a failure does not restart her');
    assert.equal(f.switcher.held, false);
  } finally {
    f.done();
  }
});
