// 交给她 (src/common/handover.ts, src/main/handover/*.ts): drops and a window handed to her.
// A fake helper, a fake desktop layer, a fake import and a fake character library.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { appKitY, helperY } from '../src/common/attention.ts';
import { silentSource } from '../src/common/feed.ts';
import { DropBacklog, splitMotion, windowHandover } from '../src/common/handover.ts';
import type { DropItem } from '../src/common/stack-cards.ts';
import { DropHandover, opsMotionImport } from '../src/main/handover/drop.ts';
import type { DesktopAssembly } from '../src/main/desktop/assembly.ts';
import { dragRelease, shellWindowHandover, type WindowPorts } from '../src/main/handover/window.ts';
import type { OpsContext } from '../src/main/ops/context.ts';

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
const file = (path: string): DropItem => ({ kind: 'file', path });

/** A fake helper answering each op from `answers`; every request is kept. */
function fakeHelper(answers: Record<string, { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }>) {
  const asked: { op: string; params: Record<string, unknown> | undefined }[] = [];
  return {
    asked,
    request: async (op: string, params?: Record<string, unknown>) => {
      asked.push({ op, params });
      const answer = answers[op];
      if (!answer) throw new Error(`unexpected op ${op}`);
      return answer;
    },
  };
}

function fakeDesktop() {
  const calls: string[] = [];
  return {
    calls,
    addDrop: (items: DropItem[], truncated: boolean) => calls.push(`drop ${JSON.stringify(items)} truncated=${truncated}`),
    notice: (text: string) => calls.push(`notice ${text}`),
    openQuickInput: (first: unknown) => calls.push(`quickInput ${JSON.stringify(first)}`),
  };
}

test('splitMotion: the first ZIP is the motion before any VMD, the other VMDs ride along, the first audio file only beside one', () => {
  const items: DropItem[] = [file('/a/one.vmd'), { kind: 'url', url: 'https://x' }, file('/a/song.MP3'), file('/a/pack.Zip'),
    file('/a/two.vmd'), file('/a/three.zip'), { kind: 'text', text: 'hi' }, file('/a/other.wav')];
  assert.deepEqual(splitMotion(items), { source: '/a/pack.Zip', extras: ['/a/one.vmd', '/a/two.vmd'], bgm: '/a/song.MP3',
    rest: [{ kind: 'url', url: 'https://x' }, file('/a/three.zip'), { kind: 'text', text: 'hi' }, file('/a/other.wav')] });
  assert.deepEqual(splitMotion([file('/a/dance.vmd')]), { source: '/a/dance.vmd', extras: [], bgm: null, rest: [] });
  const plain = [file('/a/song.mp3'), file('/a/.vmd'), file('/a/notes.txt')];
  assert.deepEqual(splitMotion(plain), { source: null, extras: [], bgm: null, rest: plain });
});

test('DropBacklog keeps the last 4 drops, oldest first, and empties on drain', () => {
  const backlog = new DropBacklog();
  for (let n = 1; n <= 5; n += 1) backlog.add([file(`/f${n}`)], n === 5);
  assert.equal(backlog.count, 4);
  assert.deepEqual(backlog.drain().map((d) => [d.items[0], d.truncated]), [[file('/f2'), false], [file('/f3'), false], [file('/f4'), false],
    [file('/f5'), true]]);
  assert.equal(backlog.count, 0);
});

test('drop: the rest of a drop is a 交给她 card on the desktop layer, or waits for it', async () => {
  const lines: string[] = [];
  let desktop: ReturnType<typeof fakeDesktop> | null = null;
  const imports: unknown[] = [];
  const drops = new DropHandover({ desktop: () => desktop, importMotion: async (f) => { imports.push(f); return { ok: true, action: {} }; },
    log: (line) => lines.push(line) });
  drops.drop({ items: [{ kind: 'url', url: 'https://a' }], x: 1, y: 2, truncated: true });
  drops.drop({ items: [{ kind: 'text', text: 'hello' }, { kind: 'file', path: '/tmp/a.txt' }], x: 1, y: 2, truncated: false });
  assert.deepEqual(lines, ['drop queued: desktop layer not ready count=1', 'drop queued: desktop layer not ready count=2']);
  desktop = fakeDesktop();
  drops.desktopReady();
  drops.drop({ items: [{ kind: 'text', text: 'later' }], x: 0, y: 0, truncated: false });
  await settle();
  const [handle] = [...drops.dropped.keys()];
  assert.deepEqual([...drops.dropped], [[handle, '/tmp/a.txt']], 'a file waiting for the layer gets its handle with its card');
  assert.deepEqual(desktop.calls, [
    'drop [{"kind":"url","url":"https://a"}] truncated=true',
    `drop [{"kind":"text","text":"hello"},{"kind":"file","path":"/tmp/a.txt","handle":"${handle}"}] truncated=false`,
    'drop [{"kind":"text","text":"later"}] truncated=false',
  ]);
  assert.deepEqual(imports, []);
  drops.desktopReady();
  assert.equal(desktop.calls.length, 3);
});

test('drop: a dropped motion is imported directly and the rest still becomes a card; the notice says how it went', async () => {
  const desktop = fakeDesktop();
  const replies: Record<string, unknown>[] = [{ ok: true, action: { id: 'mmd_dance', title: 'dance' } },
    { ok: false, reason: 'busy', detail: '角色正在切换，或另一个导入还没完成' }, { ok: false, reason: 'cancelled' }];
  const imports: unknown[] = [];
  const drops = new DropHandover({ desktop: () => desktop, importMotion: async (f) => { imports.push(f); return replies.shift()!; },
    log: () => {} });
  drops.drop({ items: [{ kind: 'file', path: '/m/dance.zip' }, { kind: 'file', path: '/m/a.vmd' }, { kind: 'file', path: '/m/bgm.m4a' },
    { kind: 'text', text: 'note' }], x: 0, y: 0, truncated: false });
  await settle();
  assert.deepEqual(imports, [{ source: '/m/dance.zip', extras: ['/m/a.vmd'], bgm: '/m/bgm.m4a' }]);
  assert.deepEqual(desktop.calls, ['drop [{"kind":"text","text":"note"}] truncated=false', 'notice 已导入动作：dance']);
  drops.drop({ items: [{ kind: 'file', path: '/m/b.vmd' }], x: 0, y: 0, truncated: false });
  await settle();
  drops.drop({ items: [{ kind: 'file', path: '/m/c.vmd' }], x: 0, y: 0, truncated: false });
  await settle();
  assert.deepEqual(desktop.calls.slice(2), ['notice 导入失败：角色正在切换，或另一个导入还没完成']);
});

/** An OpsContext with a fake library and link, enough for `character.importMotion`. */
function importContext(o: { linked: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'handover-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  const tools: string[][] = [];
  const hello = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['actions'] };
  const link = { hello: hello as unknown, currentCharacter: 'si' } as NonNullable<OpsContext['avatar']>;
  const ctx = {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null, store: null,
    diag: null, avatar: o.linked ? link : null, switcher: o.linked ? { busy: false, held: false } : null,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }),
      restartAvatar: () => {
        (link as { hello: unknown }).hello = null;
        setTimeout(() => { (link as { hello: unknown }).hello = hello; }, 20);
      } },
    library: { catalog: join(dir, 'library', 'current.json'), launched: 'si', characterName: 'Si', hookCommand: '',
      validationHost: () => 'host-bin', rosterChanged: () => {},
      runTool: async (script: string, args: string[]) => {
        tools.push([script, ...args]);
        return { last: JSON.stringify({ ok: true, action: { id: 'mmd_dance', title: 'dance', duration_s: 3, has_bgm: false } }), status: 0,
          stderr: '' };
      } },
    confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
  } as unknown as OpsContext;
  return { ctx, tools, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('opsMotionImport runs character.importMotion on the dropped files without a panel; without her it is 角色还没连上', async () => {
  const linked = importContext({ linked: true });
  try {
    const reply = await opsMotionImport(linked.ctx)({ source: '/m/dance.vmd', extras: [], bgm: '/m/song.mp3' });
    assert.equal(reply.ok, true);
    assert.equal((reply.action as { title: string }).title, 'dance');
    assert.deepEqual(linked.tools[0]!.slice(0, 9), ['motion_tool.py', 'import', '--library', join(linked.ctx.config.supportDir!, 'library'),
      '--character', 'si', '--source', '/m/dance.vmd', '--bgm']);
    assert.equal(linked.tools[0]![9], '/m/song.mp3');
  } finally {
    linked.done();
  }
  const alone = importContext({ linked: false });
  try {
    assert.deepEqual(await opsMotionImport(alone.ctx)({ source: '/m/dance.vmd', extras: [], bgm: null }),
      { ok: false, reason: 'internal', detail: '角色还没连上' });
    assert.deepEqual(alone.tools, []);
  } finally {
    alone.done();
  }
});

test('windowHandover: no Option ignores; text sharing off or no window refuses with a line; else 快速输入 gets the window', () => {
  const w = { windowId: 7, pid: 42, title: 'Doc', app: 'Pages' };
  assert.deepEqual(windowHandover(false, false, w), { kind: 'ignore' });
  assert.deepEqual(windowHandover(true, false, w), { kind: 'refuse', text: '读窗口文字没有打开，可以在设置的隐私里打开' });
  assert.deepEqual(windowHandover(true, true, null), { kind: 'refuse', text: '这里没有可以读的窗口' });
  assert.deepEqual(windowHandover(true, true, w), { kind: 'window', windowId: 7, pid: 42, title: 'Doc', app: 'Pages' });
});

test('dragRelease: with Option down, the layer-0 window under the release point, outside her pids, opens 快速输入', async () => {
  const helper = fakeHelper({
    'input.modifiers': { ok: true, result: { alt: true, shift: false, control: false, meta: false } },
    'windows.at_point': { ok: true, result: { window: { window_id: 7, pid: 42, bounds: {}, layer: 0, alpha: 1, title: 'Doc', app_name: 'Pages' } } },
  });
  const desktop = fakeDesktop();
  const ports = { helper, settings: () => ({ share_window_text: true }), helperY: appKitY, mainHeight: () => 1000, desktop: () => desktop };
  await dragRelease(ports, { x: 300, y: 200 }, [11, 12]);
  assert.deepEqual(helper.asked, [{ op: 'input.modifiers', params: undefined },
    { op: 'windows.at_point', params: { point: { x: 300, y: 800 }, exclude_pids: [11, 12], layer0_only: true, include_titles: true } }]);
  assert.deepEqual(desktop.calls, ['quickInput {"kind":"window","windowId":7,"pid":42,"title":"Doc","app":"Pages"}']);
  helper.asked.length = 0;
  await dragRelease({ ...ports, helperY }, { x: 5, y: 6 }, []);
  assert.deepEqual(helper.asked[1]!.params!.point, { x: 5, y: 6 });
});

test('dragRelease: no Option asks for no window; text sharing off or level status, or no window, says why', async () => {
  const up = (alt: boolean, window: unknown, settings: Record<string, unknown>) => {
    const helper = fakeHelper({ 'input.modifiers': { ok: true, result: { alt, shift: false, control: false, meta: false } },
      'windows.at_point': { ok: true, result: { window } } });
    const desktop = fakeDesktop();
    return { helper, desktop, ports: { helper, settings: () => settings, helperY: appKitY, mainHeight: () => 900, desktop: () => desktop } };
  };
  const off = up(false, null, { share_window_text: true });
  await dragRelease(off.ports, { x: 1, y: 1 }, []);
  assert.deepEqual(off.helper.asked.map((a) => a.op), ['input.modifiers']);
  assert.deepEqual(off.desktop.calls, []);
  const window = { window_id: 1, pid: 2, bounds: {}, layer: 0, alpha: 1 };
  for (const settings of [{}, { share_window_text: true, screen_context_level: 'status' }]) {
    const s = up(true, window, settings);
    await dragRelease(s.ports, { x: 1, y: 1 }, []);
    assert.deepEqual(s.desktop.calls, ['notice 读窗口文字没有打开，可以在设置的隐私里打开']);
  }
  const none = up(true, null, { share_window_text: true });
  await dragRelease(none.ports, { x: 1, y: 1 }, []);
  assert.deepEqual(none.desktop.calls, ['notice 这里没有可以读的窗口']);
  const untitled = up(true, window, { share_window_text: true });
  await dragRelease(untitled.ports, { x: 1, y: 1 }, []);
  assert.deepEqual(untitled.desktop.calls, ['quickInput {"kind":"window","windowId":1,"pid":2,"title":null,"app":null}']);
  const failed = fakeHelper({ 'input.modifiers': { ok: false, error: { code: 'helper_exited', message: 'gone' } } });
  const quiet = fakeDesktop();
  await dragRelease({ helper: failed, settings: () => ({ share_window_text: true }), helperY: appKitY, mainHeight: () => 900,
    desktop: () => quiet }, { x: 1, y: 1 }, []);
  assert.deepEqual(failed.asked.map((a) => a.op), ['input.modifiers']);
  assert.deepEqual(quiet.calls, []);
});

test('shellWindowHandover: the link\'s onDragRelease runs dragRelease on the desktop layer as index.ts has it; none with --no-attention', async () => {
  const helper = fakeHelper({
    'input.modifiers': { ok: true, result: { alt: true, shift: false, control: false, meta: false } },
    'windows.at_point': { ok: true, result: { window: { window_id: 7, pid: 42, bounds: {}, layer: 0, alpha: 1, title: 'Doc', app_name: 'Pages' } } },
  });
  const desktop = fakeDesktop();
  // DesktopAssembly is a desktop port as it is.
  const assembly: WindowPorts['desktop'] = (): DesktopAssembly | null => null;
  const ports = { helper, settings: () => ({ share_window_text: true }), helperY: appKitY, mainHeight: () => 1000, desktop: () => desktop };
  assert.equal(shellWindowHandover({ ...ports, argv: ['--no-attention'] }), null);
  assert.equal(assembly(), null);
  const onDragRelease = shellWindowHandover({ ...ports, argv: [] })!;
  onDragRelease({ x: 300, y: 200 }, [99, 4242]);
  await settle();
  assert.deepEqual(helper.asked.map((a) => a.op), ['input.modifiers', 'windows.at_point']);
  assert.deepEqual(helper.asked[1]!.params!.exclude_pids, [99, 4242]);
  assert.deepEqual(desktop.calls, ['quickInput {"kind":"window","windowId":7,"pid":42,"title":"Doc","app":"Pages"}']);
});
