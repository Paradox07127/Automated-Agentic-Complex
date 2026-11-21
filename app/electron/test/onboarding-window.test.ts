// The first-run guide's window (src/main/onboarding/window.ts); the guide's end (ops/onboarding.ts);
// push-to-talk's trial readout (common/push-to-talk.ts); `app.action('open_onboarding')`, `app.openQuickInput` and
// `app.info` / 复制诊断 (ops/app.ts). Fake windows, a fake helper and temporary
// directories: no window opens, no microphone or hot key is touched.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { type Handler, handle } from '../src/common/bridge.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { type HelperAnswer, PushToTalk, type VoiceTrial } from '../src/common/push-to-talk.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { onboardingWindow, type OnboardingDestination } from '../src/main/onboarding/window.ts';
import { bundleBuild } from '../src/main/ops/app.ts';
import type { WebGuardPorts } from '../src/main/web-guard.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';

const POSIX_MODES = process.platform === 'win32' ? 'a read-only config.json needs POSIX file modes' : false;
const sender = { mainFrame: true, origin: ORIGIN };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'onboarding-'));
}

/** A BrowserWindow with the calls the guide's window makes. */
function fakeWindow(id: number) {
  const calls: string[] = [];
  let openHandler: ((d: { url: string }) => { action: string }) | null = null;
  const contents = Object.assign(new EventEmitter(), { id, send() {}, isDestroyed: () => false, getURL: () => `${ORIGIN}/main.html#/onboarding`,
    setWindowOpenHandler(h: (d: { url: string }) => { action: string }) { openHandler = h; }, open: (url: string) => openHandler?.({ url }) });
  let minimized = false;
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    loadURL: async (url: string) => { calls.push(`load ${url}`); },
    center: () => { calls.push('center'); },
    show: () => { calls.push('show'); },
    showInactive: () => { calls.push('showInactive'); },
    isMinimized: () => minimized,
    minimize: () => { minimized = true; },
    restore: () => { minimized = false; calls.push('restore'); },
    close: (): void => {
      calls.push('close');
      win.emit('closed');
    },
  });
  return { win, calls };
}

function guideSetup(o: { served?: boolean; ops?: boolean; activate?: boolean; config?: Record<string, unknown>; guard?: WebGuardPorts;
  workArea?: { width: number; height: number } } = {}) {
  const dir = tempDir();
  const configPath = join(dir, 'config.json');
  if (o.config) writeFileSync(configPath, JSON.stringify(o.config));
  const made: { options: BrowserWindowConstructorOptions; fake: ReturnType<typeof fakeWindow> }[] = [];
  const registered = new Map<number, ReadonlyMap<string, Handler<PageSession>>>();
  const opened: string[] = [], logs: string[] = [];
  let guides = 0;
  const guide = onboardingWindow({
    configPath,
    makeWindow: (options) => {
      const fake = fakeWindow(made.length + 1);
      made.push({ options, fake });
      return fake.win as unknown as BrowserWindow;
    },
    served: () => o.served ?? true,
    workArea: () => o.workArea ?? { width: 1920, height: 1055 },
    ops: () => {
      if (o.ops === false) return null;
      guides += 1;
      return new Map([['onboarding.state', () => guides]]);
    },
    register: (contents, _page, ops) => registered.set(contents.id, ops),
    unregister: (id) => registered.delete(id),
    openMain: (route) => opened.push(route),
    activate: o.activate ?? false,
    ...(o.guard && { guard: o.guard }),
    log: (line) => logs.push(line),
  });
  return { dir, guide, made, registered, opened, logs, guides: () => guides };
}

test('a first run is config.json without onboarding_done true (OnboardingMarker.done)', () => {
  for (const [config, first] of [[undefined, true], [{}, true], [{ onboarding_done: false }, true], [{ onboarding_done: 'yes' }, true],
    [{ onboarding_done: true }, false]] as const) {
    const s = guideSetup({ config });
    assert.equal(s.guide.firstRun(), first, JSON.stringify(config));
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('begin opens main.html#/onboarding in a 1080×760 titled, resizable, closable, miniaturizable window on the onboarding surface', () => {
  const s = guideSetup();
  try {
    s.guide.begin();
    assert.equal(s.made.length, 1);
    const { options, fake } = s.made[0]!;
    assert.deepEqual(options, { width: 1080, height: 760, useContentSize: true, title: '首次启动引导', resizable: true, minWidth: 900,
      minHeight: 560, maximizable: false, fullscreenable: false, minimizable: true, closable: true, show: false });
    assert.deepEqual(fake.calls, [`load ${ORIGIN}/main.html#/onboarding`, 'center']);
    assert.ok(s.registered.has(1), 'the page has the bridge');
    assert.deepEqual(s.logs, ['ONBOARDING shown']);
    fake.win.emit('ready-to-show');
    assert.equal(fake.calls.at(-1), 'showInactive', 'a test instance does not take the focus');
    const title = { prevented: false, preventDefault() { this.prevented = true; } };
    fake.win.emit('page-title-updated', title);
    assert.ok(title.prevented, 'the window keeps its title');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('on a 1280×800 screen the whole window, frame and title bar included, fits the work area; the page scrolls the rest', () => {
  for (const [area, size] of [[{ width: 1280, height: 775 }, [1080, 727]], [{ width: 1280, height: 705 }, [1080, 657]],
    [{ width: 1024, height: 640 }, [976, 592]]] as const) {
    const s = guideSetup({ workArea: area });
    s.guide.begin();
    const { width, height } = s.made[0]!.options;
    assert.deepEqual([width, height], size, JSON.stringify(area));
    assert.ok(width! + 48 <= area.width && height! + 48 <= area.height, 'content and a frame up to 48 px fit');
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('begin on an open guide, minimized too, only brings it front; after it closed a new guide starts from step 1', () => {
  const s = guideSetup({ activate: true });
  try {
    s.guide.begin();
    const { fake } = s.made[0]!;
    fake.win.emit('ready-to-show');
    assert.equal(fake.calls.at(-1), 'show');
    fake.win.minimize();
    s.guide.begin();
    assert.deepEqual(fake.calls.slice(-2), ['restore', 'show']);
    assert.equal(s.made.length, 1);
    assert.equal(s.guides(), 1);
    s.guide.end('home');
    assert.equal(s.registered.size, 0, 'closing takes the bridge away');
    s.guide.begin();
    assert.equal(s.made.length, 2);
    assert.equal(s.guides(), 2, 'OnboardingHost.begin makes a new model');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('begin without the built web UI or without config logs why and opens nothing', () => {
  const a = guideSetup({ served: false }), b = guideSetup({ ops: false });
  try {
    a.guide.begin();
    b.guide.begin();
    assert.equal(a.made.length + b.made.length, 0);
    assert.deepEqual(a.logs, ['onboarding: no built web UI']);
    assert.deepEqual(b.logs, ['onboarding: no guide (config failed)']);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('the guide\'s page has the main window\'s guards: links to the system browser, no new window, edit menu, ui.log', () => {
  const opened: string[] = [], menus: unknown[] = [];
  const s0 = guideSetup();
  const logsDir = join(s0.dir, 'web-logs');
  const s = guideSetup({ guard: { origin: ORIGIN, openExternal: (u) => opened.push(u), popUpMenu: (_c, items) => menus.push(items), logsDir } });
  try {
    s.guide.begin();
    const contents = s.made[0]!.fake.win.webContents;
    let prevented = false;
    contents.emit('will-frame-navigate', { url: 'https://example.com/', isMainFrame: true, preventDefault: () => { prevented = true; } });
    assert.ok(prevented, 'the guide stays on the UI scheme');
    assert.deepEqual(contents.open('https://example.com/new'), { action: 'deny' });
    assert.deepEqual(opened, ['https://example.com/', 'https://example.com/new']);
    contents.emit('context-menu', {}, { isEditable: true, selectionText: '', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
    assert.equal(menus.length, 1, 'a text field has the edit menu');
    contents.emit('console-message', { level: 'error', message: 'boom', sourceId: 'main.js', lineNumber: 3 });
    assert.match(readFileSync(join(logsDir, 'ui.log'), 'utf8'), /boom/);
  } finally {
    rmSync(s0.dir, { recursive: true, force: true });
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('end closes the guide and opens the main window at the destination (MainWindowRouter.endOnboarding)', () => {
  for (const [destination, route] of [['home', '/home'], ['model', '/settings?group=model'], ['plugins', '/settings?group=plugins']] as const) {
    const s = guideSetup();
    s.guide.begin();
    s.guide.end(destination);
    assert.equal(s.made[0]!.fake.calls.at(-1), 'close');
    assert.deepEqual(s.opened, [route]);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

function context(dir: string, extra: Partial<OpsContext> = {}): OpsContext {
  return {
    surface: 'onboarding', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null,
    store: null, diag: null, supervisor: null, library: null, confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
    ...extra,
  };
}

async function call(ops: ReadonlyMap<string, Handler<PageSession>>, op: string, args: unknown[] = [], page = new PageSession(() => {}),
  surface: 'main' | 'onboarding' = 'onboarding') {
  return handle(surface, sender, { op, args }, ops, page);
}

/** The guide over `config`; `complete` walks to its closing screen first, `ends` and `restarts` count what its end did. */
function closing(dir: string, config: Record<string, unknown>) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const ends: OnboardingDestination[] = [];
  let restarts = 0;
  const ops = registry(context(dir, {
    endOnboarding: (destination) => {
      assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).onboarding_done, true, 'marked before it ends');
      ends.push(destination);
    },
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => { restarts += 1; }, avatar: () => ({ kind: 'stopped' }) },
  }));
  const complete = async (choice: unknown) => {
    for (const op of ['onboarding.advance', 'onboarding.advance']) assert.ok((await call(ops, op)).ok, op);
    return call(ops, 'onboarding.complete', [choice]);
  };
  return { ops, ends, complete, restarts: () => restarts, config: () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) };
}

test('只陪伴 writes plugins.light_ai false, restarts agentd on it and ends the guide at home, not at the AI account', async () => {
  const dir = tempDir();
  try {
    const g = closing(dir, { mute: false });
    const reply = await g.complete({ companion: 'pet' });
    assert.ok(reply.ok);
    assert.equal((reply.value as { done: boolean }).done, true);
    assert.deepEqual(g.config(), { mute: false, onboarding_done: true, plugins: { light_ai: false } });
    assert.equal(g.restarts(), 1);
    assert.deepEqual(g.ends, ['home']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('陪伴加对话 writes plugins.light_ai true and opens the main window at 设置 › AI 账号; agentd restarts only on a change', async () => {
  const dir = tempDir();
  try {
    const g = closing(dir, { mute: false, plugins: { screen_awareness: false } });
    assert.ok((await g.complete({ companion: 'chat' })).ok);
    assert.deepEqual(g.config(), { mute: false, onboarding_done: true, plugins: { light_ai: true, screen_awareness: false } });
    assert.equal(g.restarts(), 0, 'light AI was on already');
    assert.deepEqual(g.ends, ['model']);
    const again = closing(dir, { plugins: { light_ai: false } });
    assert.ok((await again.complete({ companion: 'chat' })).ok);
    assert.equal(again.restarts(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('打开插件设置 stores the choice and ends the guide at 设置 › 插件', async () => {
  const dir = tempDir();
  try {
    const g = closing(dir, {});
    assert.ok((await g.complete({ companion: 'chat', destination: 'plugins' })).ok);
    assert.deepEqual(g.config().plugins, { light_ai: true });
    assert.deepEqual(g.ends, ['plugins']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('onboarding.complete refuses a choice other than { companion: pet | chat, destination?: plugins } and writes nothing', async () => {
  const dir = tempDir();
  try {
    const g = closing(dir, { mute: false });
    assert.deepEqual(await g.complete('chat'), { ok: false, error: { code: 'invalid_args', detail: 'onboarding choice' } });
    for (const bad of [null, { companion: 'both' }, { companion: 'pet', destination: 'model' }, { companion: 'pet', light_ai: true }]) {
      assert.deepEqual(await call(g.ops, 'onboarding.complete', [bad]), { ok: false, error: { code: 'invalid_args', detail: 'onboarding choice' } });
    }
    assert.deepEqual(g.config(), { mute: false });
    assert.deepEqual([g.ends, g.restarts()], [[], 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完成 that cannot write config.json keeps the guide open with the error', { skip: POSIX_MODES }, async () => {
  const dir = tempDir();
  try {
    const g = closing(dir, { mute: false });
    chmodSync(dir, 0o500);
    const reply = await g.complete({ companion: 'pet' });
    chmodSync(dir, 0o700);
    assert.ok(reply.ok);
    assert.equal((reply.value as { completionError: string | null }).completionError, '配置没有存上，请检查配置文件权限后再点完成重试');
    assert.deepEqual([g.ends, g.restarts()], [[], 0]);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Push-to-talk on a fake clock and helper that records `ms`, hearing `text`, with `levels` RMS buffers in between. */
async function trialRun(levels: number[], ms: number, text: string) {
  let clock = 1_800_000_000_000;
  const trials: VoiceTrial[] = [];
  const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
  const answers: Record<string, HelperAnswer> = { 'ptt.register': ok({}), 'permissions.status': ok({ microphone: 'granted' }),
    'mic.start': ok({}), 'mic.stop': ok({ text }) };
  const ptt = new PushToTalk('control+option+space', {
    helper: { request: async (op) => answers[op] ?? { ok: false, error: { code: 'unsupported' } } },
    agentd: async () => ({ status: 202, body: JSON.stringify({ line_id: 'l1' }) }),
    stopSpeech: () => {}, onHint: () => {}, onTrial: (t) => trials.push(t), locale: () => 'zh-CN', now: () => clock,
    after: () => () => {}, log: () => {},
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  ptt.helper(true);
  ptt.agentd(true);
  await settle();
  ptt.event('ptt.down', {});
  await settle();
  for (const rms of levels) {
    clock += ms / levels.length;
    ptt.event('mic.level', { session: 'ptt-1', rms });
  }
  ptt.event('speech.partial', { session: 'ptt-1', text: '你好' });
  ptt.event('ptt.up', {});
  await settle();
  return trials;
}

test('push-to-talk hands every hint change its trial readout: the last 40 levels as 0–20 pt bars, mm:ss and the words', async () => {
  const trials = await trialRun([...Array(45).fill(0.01), 0.001, 1, 0.1, 0], 62_500, '你好 世界');
  assert.ok(trials.length > 0);
  const listening = trials.findLast((t) => t.transcript === '你好')!;
  assert.equal(listening.levels.length, 40);
  const height = (rms: number) => (20 * Math.log10(rms) + 50) / 50 * 20;
  assert.deepEqual(listening.levels.slice(-5), [height(0.01), 0, 20, height(0.1), 0], 'below −50 dBFS and silence are 0');
  assert.equal(listening.elapsed, '01:02');
  assert.deepEqual(trials[0], { levels: [], elapsed: '00:00', transcript: '' }, 'a press starts a new try');
  assert.deepEqual(trials.at(-1), listening, 'the sent hint keeps the readout of the try');
});

test('app.action open_onboarding opens the guide through its port', async () => {
  const dir = tempDir();
  try {
    let opened = 0;
    const ops = registry(context(dir, { surface: 'main', openOnboarding: () => { opened += 1; } }));
    assert.deepEqual(await call(ops, 'app.action', ['open_onboarding'], undefined, 'main'), { ok: true, value: null });
    assert.equal(opened, 1);
    assert.deepEqual(await call(registry(context(dir, { surface: 'main' })), 'app.action', ['open_onboarding'], undefined, 'main'),
      { ok: false, error: { code: 'not_implemented', detail: 'open_onboarding' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app.openQuickInput opens the desktop 快速输入; without config it fails', async () => {
  const dir = tempDir();
  try {
    let opened = 0;
    const ops = registry(context(dir, { surface: 'main', openQuickInput: () => { opened += 1; } }));
    assert.deepEqual(await call(ops, 'app.openQuickInput', [], undefined, 'main'), { ok: true, value: null });
    assert.equal(opened, 1);
    assert.deepEqual(await call(registry(context(dir, { surface: 'main', openQuickInput: null })), 'app.openQuickInput', [], undefined, 'main'),
      { ok: false, error: { code: 'failed', detail: '快速输入不可用（配置出错）' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app.info carries the build commit the shell read; without it empty', async () => {
  const dir = tempDir();
  try {
    const info = async (app: OpsContext['app']) => {
      const r = await call(registry(context(dir, { surface: 'main', app })), 'app.info', [], undefined, 'main');
      return (r as { ok: true; value: Record<string, unknown> }).value.buildGit;
    };
    assert.equal(await info({ version: '0', os: 'test', buildGit: 'abc1234' }), 'abc1234');
    assert.equal(await info({ version: '0', os: 'test' }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app.info gives the hook installer\'s dry run and install steps when the shell has the command', async () => {
  const dir = tempDir();
  try {
    const steps = async (library: OpsContext['library']) => {
      const r = await call(registry(context(dir, { surface: 'main', library })), 'app.info', [], undefined, 'main');
      return (r as { ok: true; value: Record<string, unknown> }).value.hookInstallSteps;
    };
    const cmd = "'/py' '/agentd/tools/install_hooks.py' --hook-script '/s/bin/agentic-complex-hook'";
    assert.deepEqual(await steps({ catalog: null, launched: '', characterName: '', hookCommand: cmd, validationHost: () => '',
      runTool: async () => ({ last: '', status: 0, stderr: '' }), rosterChanged: () => {} }), [
      { label: '先看会改什么', command: `${cmd} --dry-run`, terminal: true },
      { label: '确认改动后执行', command: cmd, terminal: true },
    ]);
    assert.deepEqual(await steps(null), [], 'config.json did not load');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app.info reads the dev deployment\'s dev-receipt.json at each call; one without its four fields is none (DevResources.receipt)', async () => {
  const dir = tempDir();
  try {
    const dev = join(dir, 'current');
    mkdirSync(dev);
    const info = async () => {
      const r = await call(registry(context(dir, { surface: 'main', config: { path: join(dir, 'config.json'), supportDir: dir, devResources: dev } })),
        'app.info', [], undefined, 'main');
      const v = (r as { ok: true; value: Record<string, unknown> }).value;
      return [v.source, v.devCommit, v.devDirty, v.devUiHash, v.devAgentdHash];
    };
    assert.deepEqual(await info(), ['dev', '', false, '', ''], 'no receipt yet');
    writeFileSync(join(dev, 'dev-receipt.json'), JSON.stringify({ commit: 'abc', dirty: true, ui_sha256: 'u', agentd_sha256: 'a', part: 'web' }));
    assert.deepEqual(await info(), ['dev', 'abc', true, 'u', 'a']);
    writeFileSync(join(dev, 'dev-receipt.json'), JSON.stringify({ commit: 'abc', dirty: true, ui_sha256: 'u' }));
    assert.deepEqual(await info(), ['dev', '', false, '', ''], 'agentd_sha256 missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('复制诊断 works while config.json does not load, from the logs the launch error went to', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'config.json'), '{');
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'companion.log'), 'CONFIG_ERROR config.json unreadable: JSON 无效\n');
    let copied = '';
    const ops = registry(context(dir, { surface: 'main', config: { path: join(dir, 'config.json'), supportDir: null, devResources: null },
      clipboard: { writeText: (text) => { copied = text; } } }));
    assert.deepEqual(await call(ops, 'app.action', ['copy_diagnostics'], undefined, 'main'), { ok: true, value: null });
    assert.equal(copied.split('\n').at(-1), 'CONFIG_ERROR config.json unreadable: JSON 无效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('the build number is the packaged app\'s Info.plist CFBundleVersion, else ? (DiagnosticsReport.text)', () => {
  const dir = tempDir();
  try {
    assert.equal(bundleBuild(null), '?', 'not packaged');
    assert.equal(bundleBuild(dir), '?', 'no Info.plist');
    writeFileSync(join(dir, 'Info.plist'), '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>A</string></dict></plist>');
    assert.equal(bundleBuild(dir), '?', 'no CFBundleVersion');
    writeFileSync(join(dir, 'Info.plist'), '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleVersion</key>\n\t<string>20261120.141852</string>\n</dict>\n</plist>');
    assert.equal(bundleBuild(dir), '20261120.141852');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('复制诊断 lists the renderer\'s real state beside agentd\'s', async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'logs'));
    let copied = '';
    const ops = registry(context(dir, {
      surface: 'main', clipboard: { writeText: (text) => { copied = text; } },
      supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'failed', reason: 'exit 3' }) },
    }));
    assert.ok((await call(ops, 'app.action', ['copy_diagnostics'], undefined, 'main')).ok);
    assert.deepEqual(copied.split('\n').slice(2, 7), ['子进程', 'agentd: running', 'avatar: failed(exit 3)', 'tunnel: stopped', '']);
    assert.equal(copied.split('\n')[0], 'Agentic Complex 0 (?)');
    const tunneled = registry(context(dir, {
      surface: 'main', clipboard: { writeText: (text) => { copied = text; } },
      supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }),
        tunnel: () => ({ kind: 'external' }) },
    }));
    assert.ok((await call(tunneled, 'app.action', ['copy_diagnostics'], undefined, 'main')).ok);
    assert.equal(copied.split('\n')[5], 'tunnel: external');
    const built = registry(context(dir, { surface: 'main', clipboard: { writeText: (text) => { copied = text; } }, app: { version: '1.2', os: 'test', build: '77' } }));
    assert.ok((await call(built, 'app.action', ['copy_diagnostics'], undefined, 'main')).ok);
    assert.equal(copied.split('\n')[0], 'Agentic Complex 1.2 (77)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
