// The ops that go through the platform helper (C12): `permissions.*`,
// `open.jumpToSession`, `runFeedCommand` and `runInTerminal`, against a fake helper that records its requests and answers
// from a table. Nothing here asks the real system: no prompt, no app activation, no terminal.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle, type Reply, type Surface } from '../src/common/bridge.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { jumpPlan, matchApp, matchSession, normalizedName, parseSessions } from '../src/common/session-jump.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { AgentdClient } from '../src/main/agentd/client.ts';
import { type HelperReply, localError } from '../src/main/helper/client.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { desktopLocalId, type RunResult, systemCommands, windowsApp } from '../src/main/ops/jump.ts';

const ok = (result: Record<string, unknown>): HelperReply => ({ ok: true, result });
const err = (code: string): HelperReply => ({ ok: false, error: { code, message: code } });

/** Answers each op from its table entry; an op without one answers `unsupported`, as a helper that lacks it. */
class FakeHelper {
  readonly requests: [string, Record<string, unknown>][] = [];
  private readonly table: Record<string, HelperReply | ((params: Record<string, unknown>) => HelperReply)>;
  constructor(table: Record<string, HelperReply | ((params: Record<string, unknown>) => HelperReply)>) {
    this.table = table;
  }
  async request(op: string, params: Record<string, unknown> = {}): Promise<HelperReply> {
    this.requests.push([op, params]);
    const entry = this.table[op];
    if (entry === undefined) return err('unsupported');
    return typeof entry === 'function' ? entry(params) : entry;
  }
  ops(): string[] {
    return this.requests.map(([op]) => op);
  }
}

/** The supervisor's answer while no helper runs. */
const exited = { request: async () => localError('helper_exited', 'the helper is not running') };

interface Fakes {
  helper?: OpsContext['helper'];
  platform?: 'mac' | 'windows';
  sessions?: unknown;
  sessionsStatus?: number;
  confirm?: boolean;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  loginItem?: boolean | null;
  run?: (file: string, args: string[], limit?: number | null) => Promise<RunResult>;
  executables?: string[];
  /** The context's surface; `main` when absent. */
  surface?: Surface;
  openMain?: OpsContext['openMain'];
}

function setup(f: Fakes = {}) {
  const calls: string[] = [], lines: string[] = [], routes_: string[] = [];
  const ctx: OpsContext = {
    surface: f.surface ?? 'main', routes, config: { path: join(tmpdir(), 'helper-ops-none', 'config.json'), supportDir: null, devResources: null },
    agentd: { request: async (method: string, path: string) => {
      calls.push(`agentd ${method} ${path}`);
      return { status: f.sessionsStatus ?? 200, body: Buffer.from(JSON.stringify({ sessions: f.sessions ?? [] })) };
    } } as unknown as AgentdClient,
    store: null, diag: null, supervisor: null, library: null,
    confirm: async (text) => { calls.push(`confirm ${text}`); return f.confirm ?? true; },
    shell: {
      openExternal: f.openExternal ?? (async (url) => { calls.push(`openExternal ${url}`); }),
      openPath: f.openPath ?? (async (path) => { calls.push(`openPath ${path}`); return ''; }),
      showItemInFolder: () => {},
    },
    clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0.0.0', os: 'test' },
    loginItem: { enabled: () => (f.loginItem === undefined ? false : f.loginItem), set: (on) => { calls.push(`loginItem ${on}`); } },
    settingsChanges: silentSource,
    log: (line) => lines.push(line),
    helper: f.helper,
    openMain: f.openMain,
    platform: f.platform ?? 'mac',
    commands: {
      executable: (paths) => paths.find((p) => (f.executables ?? []).includes(p)) ?? null,
      run: async (file, args, limit) => {
        calls.push(`run ${file} ${args.join(' ')}`);
        return f.run ? f.run(file, args, limit) : { ok: true, stdout: '' };
      },
    },
  };
  // The page's `window.onRoute` gets each pushed route.
  const ops = registry(ctx), page = new PageSession((_id, _stream, _kind, payload) => { if (payload?.event === 'route') routes_.push(payload.data); });
  page.onRoute(page.generation, 1);
  const call = (op: string, args: unknown[] = [], surface: Surface = f.surface ?? 'main') =>
    handle(surface, { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page) as Promise<Reply>;
  return { calls, lines, routes: routes_, call };
}

const value = (r: Reply) => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const failure = (r: Reply) => {
  assert.ok(!r.ok, JSON.stringify(r));
  return r.error;
};

const READINGS = { accessibility: 'denied', screenRecording: 'granted', microphone: 'notDetermined', automation: 'denied',
  inputMonitoring: 'notApplicable', notifications: 'denied' };
const STATUS = ok(READINGS);

test('permissions.status reads the helper and answers in the web page\'s values, notifications among them', async () => {
  const helper = new FakeHelper({ 'permissions.status': STATUS });
  const { call } = setup({ helper });
  assert.deepEqual(value(await call('permissions.status')), {
    // WebPermissions.status: a missing screen recording or accessibility grant reads as not determined.
    accessibility: 'notDetermined', screenRecording: 'granted', microphone: 'notDetermined', automation: 'denied',
    inputMonitoring: 'unsupported', notifications: 'denied',
  });
  assert.deepEqual(helper.requests, [['permissions.status', {}]], 'never permissions.request');
});

test('permissions.status: macOS has the notification grant the helper reads, unsupported outside an app; Windows has only the microphone', async () => {
  const notifications = async (reading: string) => (value(await setup({ helper: new FakeHelper({ 'permissions.status':
    ok({ ...READINGS, notifications: reading }) }) }).call('permissions.status')) as Record<string, unknown>).notifications;
  for (const reading of ['granted', 'denied', 'notDetermined']) assert.equal(await notifications(reading), reading);
  assert.equal(await notifications('notApplicable'), 'unsupported');
  const helper = new FakeHelper({ 'permissions.status': STATUS });
  assert.deepEqual(value(await setup({ helper, platform: 'windows' }).call('permissions.status')), { microphone: 'notDetermined' });
  assert.deepEqual(value(await setup({ helper: null, platform: 'windows' }).call('permissions.status')), { microphone: 'unsupported' });
});

test('permissions.status without an answer from the helper reads every helper permission as unsupported', async () => {
  const unsupported = { accessibility: 'unsupported', screenRecording: 'unsupported', microphone: 'unsupported', automation: 'unsupported',
    inputMonitoring: 'unsupported', notifications: 'unsupported' };
  for (const helper of [new FakeHelper({ 'permissions.status': err('internal') }), exited, null]) {
    assert.deepEqual(value(await setup({ helper }).call('permissions.status')), unsupported);
  }
});

test('permissions.request asks the helper for that one permission and answers its state; notifications are only read', async () => {
  const helper = new FakeHelper({ 'permissions.request': (p) => ok({ state: p.kind === 'inputMonitoring' ? 'notApplicable' : 'denied' }),
    'permissions.status': ok({ notifications: 'granted' }) });
  const { call } = setup({ helper });
  assert.equal(value(await call('permissions.request', ['microphone'])), 'denied');
  assert.equal(value(await call('permissions.request', ['screenRecording'])), 'notDetermined');
  assert.equal(value(await call('permissions.request', ['inputMonitoring'])), 'unsupported');
  assert.equal(value(await call('permissions.request', ['notifications'])), 'granted');
  assert.equal(value(await setup({ helper: new FakeHelper({}), platform: 'windows' }).call('permissions.request', ['notifications'])), 'unsupported');
  assert.deepEqual(helper.requests,[['permissions.request', { kind: 'microphone' }], ['permissions.request', { kind: 'screenRecording' }],
    ['permissions.request', { kind: 'inputMonitoring' }], ['permissions.status', {}]]);
  assert.deepEqual(failure(await call('permissions.request', ['camera'])), { code: 'invalid_args', detail: 'permission kind' });
  assert.equal(helper.requests.length, 4);
});

test('permissions.request answers unsupported when the helper fails or is not there', async () => {
  for (const helper of [new FakeHelper({ 'permissions.request': err('internal') }), exited, null]) {
    assert.equal(value(await setup({ helper }).call('permissions.request', ['accessibility'])), 'unsupported');
  }
});

test('permissions.openSettings opens its System Settings pane; screen recording and accessibility ask once first', async () => {
  const helper = new FakeHelper({});
  const { calls, call } = setup({ helper });
  for (const pane of ['screenRecording', 'accessibility', 'microphone', 'automation', 'inputMonitoring', 'notifications', 'loginItems']) {
    assert.equal(value(await call('permissions.openSettings', [pane])), null);
  }
  const security = 'openExternal x-apple.systempreferences:com.apple.preference.security?';
  assert.deepEqual(calls, [`${security}Privacy_ScreenCapture`, `${security}Privacy_Accessibility`, `${security}Privacy_Microphone`,
    `${security}Privacy_Automation`, `${security}Privacy_ListenEvent`,
    'openExternal x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    'openExternal x-apple.systempreferences:com.apple.LoginItems-Settings.extension']);
  assert.deepEqual(helper.requests, [['permissions.request', { kind: 'screenRecording' }], ['permissions.request', { kind: 'accessibility' }]]);
  assert.deepEqual(failure(await call('permissions.openSettings', ['camera'])), { code: 'invalid_args', detail: 'settings pane' });
});

test('permissions.openSettings on Windows opens the microphone page; other panes and a failed open fail', async () => {
  const win = setup({ platform: 'windows' });
  assert.equal(value(await win.call('permissions.openSettings', ['microphone'])), null);
  assert.deepEqual(win.calls, ['openExternal ms-settings:privacy-microphone']);
  assert.deepEqual(failure(await win.call('permissions.openSettings', ['accessibility'])), { code: 'failed', detail: '打不开系统设置' });
  const broken = setup({ openExternal: async () => { throw new Error('no handler'); } });
  assert.deepEqual(failure(await broken.call('permissions.openSettings', ['microphone'])), { code: 'failed', detail: '打不开系统设置' });
});

const session = (id: string, origin: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  session_id: id, own: false, target: 'claude', cwd: null, state: 'idle', updated_at: 1, title: null, origin, ...extra,
});

test('open.jumpToSession focuses a Terminal tab through the helper once Terminal runs', async () => {
  const sessions = [session('s1', { kind: 'terminal', term_program: 'Apple_Terminal', tty: '/dev/ttys004' })];
  const running = ok({ apps: [{ pid: 9, name: 'Terminal', app_id: 'com.apple.Terminal' }] });
  const helper = new FakeHelper({ 'apps.running': running, 'terminal.focus': ok({ focused: true }) });
  const { call } = setup({ helper, sessions });
  assert.equal(value(await call('open.jumpToSession', ['s1'])), null);
  assert.deepEqual(helper.requests, [['apps.running', {}], ['terminal.focus', { app: 'terminal', tty: '/dev/ttys004' }]]);
  const text = async (table: ConstructorParameters<typeof FakeHelper>[0]) =>
    failure(await setup({ helper: new FakeHelper(table), sessions }).call('open.jumpToSession', ['s1'])).detail;
  assert.equal(await text({ 'apps.running': running, 'terminal.focus': ok({ focused: false }) }), 'Terminal 里没找到该会话');
  assert.equal(await text({ 'apps.running': running, 'terminal.focus': err('not_found') }), 'Terminal 里没找到该会话');
  assert.equal(await text({ 'apps.running': running, 'terminal.focus': err('automation_denied') }), '需要在系统设置里允许 Agentic Complex 控制 Terminal');
  assert.equal(await text({ 'apps.running': ok({ apps: [] }) }), 'Terminal 没在运行');
});

test('open.jumpToSession activates the session\'s app or process, and says why when it cannot', async () => {
  const sessions = [session('pid', { kind: 'unknown', pid: 4321 }), session('app', { kind: 'unknown', bundle_id: 'com.example.ide' }),
    session('mine', null, { own: true })];
  const helper = new FakeHelper({ 'apps.activate': ok({ activated: true, pid: 4000 }) });
  const { call } = setup({ helper, sessions });
  assert.equal(value(await call('open.jumpToSession', ['pid'])), null);
  assert.equal(value(await call('open.jumpToSession', ['app'])), null);
  assert.deepEqual(helper.requests, [['apps.activate', { pid: 4321, ancestors: true }], ['apps.activate', { app_id: 'com.example.ide' }]]);
  const off = setup({ helper: new FakeHelper({ 'apps.activate': ok({ activated: false, pid: null }) }), sessions });
  assert.equal(failure(await off.call('open.jumpToSession', ['pid'])).detail, '没找到进程 4321 所在的 app');
  assert.equal(failure(await off.call('open.jumpToSession', ['app'])).detail, 'com.example.ide 没在运行');
  const gone = setup({ helper: new FakeHelper({ 'apps.activate': err('process_gone') }), sessions });
  assert.equal(failure(await gone.call('open.jumpToSession', ['pid'])).detail, '没找到进程 4321 所在的 app');
  assert.equal(failure(await off.call('open.jumpToSession', ['nope'])).detail, '没找到这个会话');
  assert.equal(failure(await setup({ sessionsStatus: 500 }).call('open.jumpToSession', ['pid'])).detail, '后台没有回应，暂时跳不过去');
  assert.deepEqual(failure(await off.call('open.jumpToSession', [''])), { code: 'invalid_args', detail: 'session id' });
});

test('an own session opens on the main window\'s sessions route, there, from a feed command and from the panels through openMain', async () => {
  const sessions = [session('mine 1', null, { own: true, cwd: '/work/mine' })];
  // The feed command is the agent's entry (activate: false), which leaves a focused main window on its page: openMain's.
  const entries: [string, boolean | undefined][] = [];
  const main = setup({ sessions, openMain: (route, activate) => { entries.push([route, activate]); } });
  assert.equal(value(await main.call('open.jumpToSession', ['mine 1'])), null);
  assert.equal(value(await main.call('open.runFeedCommand', [{ action: 'jump', target: 'mine' }])), null);
  assert.deepEqual(main.routes, ['/overview?sel=mine%201&focus=task-mine%201']);
  assert.deepEqual(entries, [['/overview?sel=mine%201&focus=task-mine%201', false]]);
  assert.deepEqual(main.lines, ['FEED command action=jump result=session_panel selected=mine 1']);
  assert.deepEqual(main.calls, ['agentd GET /sessions', 'agentd GET /sessions']);
  const opened: string[] = [];
  const stack = setup({ sessions, surface: 'stack', openMain: (route) => { opened.push(route); } });
  assert.equal(value(await stack.call('open.jumpToSession', ['mine 1'])), null);
  assert.deepEqual([opened, stack.routes], [['/overview?sel=mine%201&focus=task-mine%201'], []]);
  // Another tool's session still jumps to its terminal.
  const other = setup({ sessions: [session('theirs', null)], surface: 'stack', openMain: (route) => { opened.push(route); } });
  assert.equal(failure(await other.call('open.jumpToSession', ['theirs'])).detail, '没有可用的跳转方式');
  assert.equal(opened.length, 1);
  // Without a main window to open.
  const none = setup({ sessions, surface: 'stack' });
  assert.equal(failure(await none.call('open.jumpToSession', ['mine 1'])).detail, '没有可用的跳转方式');
  assert.deepEqual(none.routes, []);
  const noMain = setup({ sessions, helper: new FakeHelper({ 'apps.running': ok({ apps: [] }) }) });
  assert.equal(failure(await noMain.call('open.runFeedCommand', [{ action: 'jump', target: 'mine' }])).detail, '没找到「mine」');
  assert.deepEqual(noMain.routes, []);
});

test('open.jumpToSession fails with the reason when the helper is not there', async () => {
  const sessions = [session('pid', { kind: 'unknown', pid: 4321 })];
  for (const helper of [exited, null]) {
    const e = failure(await setup({ helper, sessions }).call('open.jumpToSession', ['pid']));
    assert.equal(e.code, 'failed');
    assert.match(e.detail, /系统助手/);
  }
});

test('open.jumpToSession switches tmux to the pane and activates the outer terminal of its latest client', async () => {
  const sessions = [session('t', { kind: 'tmux', tmux_socket: '/tmp/tmux-501/default', tmux_pane: '%3', pid: 1 })];
  const helper = new FakeHelper({ 'apps.activate': ok({ activated: true, pid: 70 }) });
  const { calls, call } = setup({ helper, sessions, executables: ['/usr/local/bin/tmux'],
    run: async (_file, args) => ({ ok: true, stdout: args[2] === 'list-clients' ? '/dev/ttys001 777 100\n/dev/ttys002 778 200\n' : '' }) });
  assert.equal(value(await call('open.jumpToSession', ['t'])), null);
  assert.deepEqual(calls.filter((c) => c.startsWith('run')), [
    'run /usr/local/bin/tmux -S /tmp/tmux-501/default list-clients -F #{client_tty} #{client_pid} #{client_activity}',
    'run /usr/local/bin/tmux -S /tmp/tmux-501/default switch-client -c /dev/ttys002 -t %3']);
  assert.deepEqual(helper.requests, [['apps.activate', { pid: 778, ancestors: true }]]);
  const none = setup({ helper, sessions });
  assert.equal(failure(await none.call('open.jumpToSession', ['t'])).detail, '没找到 tmux');
});

test('open.jumpToSession opens a Claude Desktop session by its local id, else activates Desktop', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'a', 'b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local_ab-1.json'), JSON.stringify({ cliSessionId: 'other', priorCliSessionIds: ['cli-1'] }));
    const sessions = [session('claude:cli-1', { kind: 'desktop' }), session('claude:cli-2', { kind: 'desktop' })];
    const helper = new FakeHelper({ 'apps.activate': ok({ activated: true, pid: 5 }) });
    const { calls, call } = setup({ helper, sessions });
    assert.equal(value(await call('open.jumpToSession', ['claude:cli-1'])), null);
    assert.deepEqual(calls.filter((c) => c.startsWith('openExternal')), ['openExternal claude://code/continue?session=local_ab-1']);
    assert.equal(failure(await call('open.jumpToSession', ['claude:cli-2'])).detail, 'Desktop 没找到该会话，已激活 Desktop');
    assert.deepEqual(helper.requests, [['apps.activate', { app_id: 'com.anthropic.claudefordesktop' }]]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(home, { recursive: true, force: true });
  }
});

test('open.jumpToSession on Windows reads Claude Desktop\'s sessions under APPDATA and activates claude.exe', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'appdata-'));
  const saved = process.env.APPDATA;
  process.env.APPDATA = appData;
  try {
    const dir = join(appData, 'Claude', 'claude-code-sessions', 'a', 'b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local_w-1.json'), JSON.stringify({ cliSessionId: 'cli-1' }));
    const sessions = [session('claude:cli-1', { kind: 'desktop' }), session('claude:cli-2', { kind: 'desktop' })];
    const helper = new FakeHelper({ 'apps.running': ok({ apps: [{ pid: 30, name: 'Claude', app_id: 'claude.exe', path: 'C:\\x\\claude.exe' }] }),
      'apps.activate': ok({ activated: true, pid: 30 }) });
    const { calls, call } = setup({ helper, sessions, platform: 'windows' });
    assert.equal(value(await call('open.jumpToSession', ['claude:cli-1'])), null);
    assert.deepEqual(calls.filter((c) => c.startsWith('openExternal')), ['openExternal claude://code/continue?session=local_w-1']);
    assert.equal(failure(await call('open.jumpToSession', ['claude:cli-2'])).detail, 'Desktop 没找到该会话，已激活 Desktop');
    assert.deepEqual(helper.requests, [['apps.running', { regular_only: true }], ['apps.activate', { pid: 30 }]]);
  } finally {
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
    rmSync(appData, { recursive: true, force: true });
  }
});

test('on Windows the apps a session runs in are their exe names and install folders', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  assert.deepEqual(windowsApp('com.microsoft.VSCode', env), { name: 'VS Code', exes: ['code.exe'],
    dirs: ['C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code', 'C:\\Program Files\\Microsoft VS Code'] });
  assert.deepEqual(windowsApp('com.todesktop.230313mzl4w4u92', env)?.exes, ['cursor.exe']);
  assert.deepEqual(windowsApp('com.anthropic.claudefordesktop', env),
    { name: 'Claude Desktop', exes: ['claude.exe'], dirs: ['C:\\Users\\x\\AppData\\Local\\AnthropicClaude'] });
  const idea = windowsApp('com.jetbrains.intellij', env);
  assert.ok(idea?.exes.includes('idea64.exe') && idea.exes.includes('pycharm64.exe'));
  assert.deepEqual(idea?.dirs, ['C:\\Program Files\\JetBrains', 'C:\\Users\\x\\AppData\\Local\\Programs']);
  assert.deepEqual(windowsApp('Microsoft.WindowsTerminal', env)?.exes, ['windowsterminal.exe']);
  assert.equal(windowsApp('com.example.ide', env), null);
});

test('open.jumpToSession on Windows activates a running app found by exe name or install folder, a pid by its window or an ancestor\'s', async () => {
  const sessions = [session('code', { kind: 'unknown', bundle_id: 'com.microsoft.VSCode' }), session('idea', { kind: 'unknown', bundle_id: 'com.jetbrains.pycharm' }),
    session('pid', { kind: 'unknown', pid: 4321 }), session('other', { kind: 'unknown', bundle_id: 'notepad.exe' })];
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const running = ok({ apps: [{ pid: 7, name: 'Explorer', app_id: 'explorer.exe', path: 'C:\\Windows\\explorer.exe' },
    { pid: 8, name: 'Visual Studio Code', app_id: 'code.exe', path: 'D:\\Tools\\VS Code\\Code.exe' },
    { pid: 9, name: 'PyCharm', app_id: 'pycharm.exe', path: `${pf}\\JetBrains\\PyCharm 2026.2\\bin\\pycharm.exe` }] });
  const helper = new FakeHelper({ 'apps.running': running, 'apps.activate': ok({ activated: true, pid: 1 }) });
  const { call } = setup({ helper, sessions, platform: 'windows' });
  for (const id of ['code', 'idea', 'pid', 'other']) assert.equal(value(await call('open.jumpToSession', [id])), null, id);
  assert.deepEqual(helper.requests, [['apps.running', { regular_only: true }], ['apps.activate', { pid: 8 }],
    ['apps.running', { regular_only: true }], ['apps.activate', { pid: 9 }], ['apps.activate', { pid: 4321, ancestors: true }],
    ['apps.activate', { app_id: 'notepad.exe' }]]);
  const none = setup({ helper: new FakeHelper({ 'apps.running': ok({ apps: [] }) }), sessions, platform: 'windows' });
  assert.equal(failure(await none.call('open.jumpToSession', ['code'])).detail, 'VS Code 没在运行');
});

test('desktopLocalId reads only <root>/*/*/local_*.json records that list the CLI session', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-'));
  try {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'local_x.json'), JSON.stringify({ cliSessionId: 'c1' }));
    writeFileSync(join(root, 'a', 'b', 'local_bad id.json'), JSON.stringify({ cliSessionId: 'c2' }));
    writeFileSync(join(root, 'a', 'local_y.json'), JSON.stringify({ cliSessionId: 'c3' }));
    assert.equal(desktopLocalId('c1', root), 'local_x');
    assert.equal(desktopLocalId('c2', root), null);
    assert.equal(desktopLocalId('c3', root), null);
    assert.equal(desktopLocalId('c1', join(root, 'missing')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('open.runFeedCommand opens an installed app the helper lists, by file or display name', async () => {
  const helper = new FakeHelper({ 'apps.installed': ok({ apps: [{ path: '/Applications/Safari.app', name: 'Safari' },
    { path: '/System/Applications/Notes.app', name: '备忘录' }] }) });
  const { calls, call } = setup({ helper });
  assert.equal(value(await call('open.runFeedCommand', [{ action: 'open', target: 'safari' }])), null);
  assert.equal(value(await call('open.runFeedCommand', [{ action: 'open', target: '备忘录' }])), null);
  assert.deepEqual(calls, ['openPath /Applications/Safari.app', 'openPath /System/Applications/Notes.app']);
  assert.equal(failure(await call('open.runFeedCommand', [{ action: 'open', target: 'Xcode' }])).detail, '没找到应用「Xcode」');
  const broken = setup({ helper, openPath: async () => 'no app' });
  assert.equal(failure(await broken.call('open.runFeedCommand', [{ action: 'open', target: 'Safari' }])).detail, '打不开「Safari」');
  for (const bad of [null, { action: 'run', target: 'x' }, { action: 'open', target: '' }, { action: 'open', target: 'x'.repeat(1025) }]) {
    assert.deepEqual(failure(await call('open.runFeedCommand', [bad])), { code: 'invalid_args', detail: '{action: open|jump, target}' });
  }
  for (const gone of [exited, null]) {
    const e = failure(await setup({ helper: gone }).call('open.runFeedCommand', [{ action: 'open', target: 'Safari' }]));
    assert.equal(e.code, 'failed');
    assert.match(e.detail, /系统助手/);
  }
});

test('open.runFeedCommand jumps to the matching session, else activates a running app', async () => {
  const sessions = [session('old', { kind: 'unknown', pid: 11 }, { cwd: '/work/proj', updated_at: 1 }),
    session('new', { kind: 'unknown', pid: 22 }, { cwd: '/other/proj/', updated_at: 2 })];
  const helper = new FakeHelper({ 'apps.activate': ok({ activated: true, pid: 1 }),
    'apps.running': ok({ apps: [{ pid: 30, name: 'Notes', app_id: 'com.apple.Notes', path: '/System/Applications/Notes.app', regular: true },
      { pid: 31, name: 'Helper', app_id: 'com.example.helper' }] }) });
  const { call } = setup({ helper, sessions });
  assert.equal(value(await call('open.runFeedCommand', [{ action: 'jump', target: 'Proj' }])), null);
  assert.equal(value(await call('open.runFeedCommand', [{ action: 'jump', target: 'notes' }])), null);
  assert.deepEqual(helper.requests, [['apps.activate', { pid: 22, ancestors: true }], ['apps.running', { regular_only: true }],
    ['apps.activate', { pid: 30 }]]);
  assert.equal(failure(await call('open.runFeedCommand', [{ action: 'jump', target: 'helper' }])).detail, '没找到「helper」');
  const off = setup({ helper: new FakeHelper({ 'apps.activate': ok({ activated: false, pid: null }) }), sessions });
  assert.equal(failure(await off.call('open.runFeedCommand', [{ action: 'jump', target: 'proj' }])).detail, '没找到进程 22 所在的 app');
  const noAgentd = setup({ helper, sessionsStatus: 503 });
  assert.equal(value(await noAgentd.call('open.runFeedCommand', [{ action: 'jump', target: 'notes' }])), null, 'no sessions: apps');
  const e = failure(await setup({ helper: exited }).call('open.runFeedCommand', [{ action: 'jump', target: 'notes' }]));
  assert.match(e.detail, /系统助手/);
});

test('open.runInTerminal checks the command, asks first, then has Terminal run it', async () => {
  const { calls, call } = setup();
  assert.equal(value(await call('open.runInTerminal', ['echo "a\\b"'])), null);
  assert.deepEqual(calls, ['confirm 在终端运行这条命令？\n\necho "a\\b"',
    'run /usr/bin/osascript -e tell application "Terminal"\nactivate\ndo script "echo \\"a\\\\b\\""\nend tell']);
  for (const bad of ['', 'a\nb', 'a‮b', 'a b', 'x'.repeat(4097), 42]) {
    assert.deepEqual(failure(await call('open.runInTerminal', [bad])), { code: 'invalid_args', detail: 'a one-line command' }, String(bad));
  }
  assert.deepEqual(failure(await setup({ confirm: false }).call('open.runInTerminal', ['ls'])), { code: 'declined', detail: 'open.runInTerminal' });
});

test('open.runInTerminal waits for osascript without the jumps\' 5 s limit: an Automation prompt or a Terminal launch takes as long as it takes', async () => {
  const limits: (number | null | undefined)[] = [];
  const { call } = setup({ run: async (_file, _args, limit) => { limits.push(limit); return { ok: true, stdout: '' }; } });
  assert.equal(value(await call('open.runInTerminal', ['ls'])), null);
  assert.deepEqual(limits, [null]);
});

test('systemCommands.run kills at its limit, and with none waits', { skip: process.platform === 'win32' ? 'runs /bin/sh' : false }, async () => {
  assert.deepEqual(await systemCommands.run('/bin/sh', ['-c', 'sleep 10'], 100), { ok: false, message: '超时' });
  assert.deepEqual(await systemCommands.run('/bin/sh', ['-c', 'sleep 0.2; echo up'], null), { ok: true, stdout: 'up\n' });
});

test('open.runInTerminal says what Terminal refused; on Windows it fails before asking', async () => {
  const refused = setup({ run: async () => ({ ok: false, message: '0:50: execution error: Not authorized to send Apple events to Terminal. (-1743)' }) });
  assert.deepEqual(failure(await refused.call('open.runInTerminal', ['ls'])),
    { code: 'failed', detail: '需要在系统设置里允许 Agentic Complex 控制 Terminal' });
  const other = setup({ run: async () => ({ ok: false, message: '0:10: execution error: Terminal got an error. (-1728)' }) });
  assert.deepEqual(failure(await other.call('open.runInTerminal', ['ls'])), { code: 'failed', detail: 'Terminal 出错：-1728' });
  const odd = setup({ run: async () => ({ ok: false, message: '无法启动 /usr/bin/osascript' }) });
  assert.deepEqual(failure(await odd.call('open.runInTerminal', ['ls'])), { code: 'failed', detail: 'Terminal 出错：unknown' });
  const win = setup({ platform: 'windows' });
  const e = failure(await win.call('open.runInTerminal', ['dir']));
  assert.equal(e.code, 'failed');
  assert.deepEqual(win.calls, []);
});

test('jumpPlan picks the most precise way', () => {
  const plan = (origin: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    jumpPlan(parseSessions({ sessions: [session('claude:x1', origin, extra)] })[0]!);
  assert.deepEqual(plan({ kind: 'terminal', entrypoint: 'claude-desktop', tmux_socket: 's', tmux_pane: 'p' }), { kind: 'desktop', cliSessionId: 'x1' });
  assert.deepEqual(plan({ kind: 'tmux', tmux_socket: 's', tmux_pane: 'p', wezterm_pane: '1' }), { kind: 'tmux', socket: 's', pane: 'p' });
  assert.deepEqual(plan({ kind: 'terminal', wezterm_pane: '1', kitty_listen_on: 'l', kitty_window_id: '2' }), { kind: 'wezterm', pane: '1' });
  assert.deepEqual(plan({ kind: 'terminal', kitty_listen_on: 'l', kitty_window_id: '2' }), { kind: 'kitty', listenOn: 'l', windowId: '2' });
  assert.deepEqual(plan({ kind: 'terminal', term_program: 'iTerm.app', tty: '/dev/t' }), { kind: 'iTermTTY', tty: '/dev/t' });
  assert.deepEqual(plan({ kind: 'terminal', term_program: 'ghostty' }, { cwd: '/w' }), { kind: 'ghostty', cwd: '/w' });
  assert.deepEqual(plan({ kind: 'terminal', term_program: 'ghostty', bundle_id: 'b' }), { kind: 'activateBundle', bundleId: 'b' });
  assert.deepEqual(plan({ kind: 'terminal', pid: 2 ** 31 }), null);
  assert.equal(plan(null), null);
  assert.equal(plan({ kind: 'terminal', pid: 3 }, { own: true }), null);
  assert.throws(() => parseSessions({ sessions: [{ session_id: 1 }] }));
});

test('feed targets match apps and sessions', () => {
  assert.equal(normalizedName(' Visual Studio Code.APP'), 'visualstudiocode');
  assert.equal(normalizedName('ＳＡＦＡＲＩ'), 'safari');
  const apps = [{ path: '/A/Code.app', displayName: 'Visual Studio Code' }, { path: '/A/Coder.app', displayName: 'Coder' },
    { path: '/A/Codex.app', displayName: 'Codex' }];
  assert.equal(matchApp('code', apps), '/A/Code.app');
  assert.equal(matchApp('cod', apps), null, 'more than one partial match');
  assert.equal(matchApp('studio', apps), '/A/Code.app');
  assert.equal(matchApp(' ', apps), null);
  const sessions = parseSessions({ sessions: [session('a', null, { title: 'Fix the parser', updated_at: 5 }),
    session('b', null, { target: 'codex', updated_at: 3 }), session('c', null, { title: 'parser notes', updated_at: 9 })] });
  assert.equal(matchSession('parser', sessions)?.sessionId, 'c');
  assert.equal(matchSession('Codex', sessions)?.sessionId, 'b');
  assert.equal(matchSession('cod', sessions), null);
});
