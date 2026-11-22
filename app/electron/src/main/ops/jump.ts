// Carries out a JumpPlan through the platform helper (`apps.running`, `terminal.focus`, `apps.activate`),
// the terminals' own command lines and Claude Desktop's route; the answer is the jump's text, `JUMPED` on success. On Windows
// an app is the running process with its exe name or under its install folder.
import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, win32 } from 'node:path';
import type { JumpPlan } from '../../common/session-jump.ts';
import type { HelperError, HelperReply } from '../helper/client.ts';
import type { OpsContext } from './context.ts';

export const JUMPED = '已跳转';
const DESKTOP_BUNDLE = 'com.anthropic.claudefordesktop';

/** stdout on exit 0, otherwise the first line of stderr or the exit reason. */
export type RunResult = { ok: true; stdout: string } | { ok: false; message: string };

/** Programs the jumps and `open.runInTerminal` run, without a shell; tests fake them. */
export interface Commands {
  /** The first of `paths` that is an executable file. */
  executable(paths: string[]): string | null;
  /** `limit` is in ms, 5 s when absent; null waits however long it runs. */
  run(file: string, args: string[], limit?: number | null): Promise<RunResult>;
}

/** Runs with stdin closed and a limit, then SIGKILL. */
function run(file: string, args: string[], limit: number | null = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let timedOut = false;
    const timer = limit === null ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limit);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, message: `无法启动 ${file}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, message: '超时' });
      if (code === 0) return resolve({ ok: true, stdout: Buffer.concat(out).toString('utf8') });
      const first = Buffer.concat(err).toString('utf8').split('\n').find((l) => l !== '');
      resolve({ ok: false, message: first ?? `退出码 ${code}` });
    });
  });
}

export const systemCommands: Commands = {
  executable: (paths) => paths.find((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null,
  run,
};

/** The helper failed (none runs, it broke, it lacks the op): the op fails with this. */
export function helperFailure(op: string, error: HelperError): Error {
  return new Error(`系统助手没能完成 ${op}（${error.code}）`);
}

/** The reply when it is a result or one of the `allowed` errors; any other error throws `helperFailure`. */
async function helperReply(ctx: OpsContext, op: string, params: Record<string, unknown>, allowed: string[]): Promise<HelperReply> {
  const reply: HelperReply = ctx.helper ? await ctx.helper.request(op, params) : { ok: false, error: { code: 'helper_exited', message: 'no helper' } };
  if (reply.ok || allowed.includes(reply.error.code)) return reply;
  ctx.log(`helper ${op} failed code=${reply.error.code} message=${reply.error.message}`);
  throw helperFailure(op, reply.error);
}

/** The reply's result; any error throws `helperFailure`. */
export async function helperResult(ctx: OpsContext, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await helperReply(ctx, op, params, []);
  if (!reply.ok) throw helperFailure(op, reply.error);
  return reply.result;
}

/** `NSRunningApplication.activate()` through the helper; a process that is gone activates nothing. */
export async function activate(ctx: OpsContext, params: Record<string, unknown>): Promise<boolean> {
  const r = await helperReply(ctx, 'apps.activate', params, ['process_gone']);
  return r.ok && r.result.activated === true;
}

/** A Windows app a session runs in: its exe names (lower case, as the helper's `app_id` and `apps.running` paths end) and
 *  the folders it installs in. */
export interface WindowsApp { name: string; exes: string[]; dirs: string[] }

const JETBRAINS_EXES = ['idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'goland64.exe', 'clion64.exe', 'rider64.exe', 'phpstorm64.exe',
  'rubymine64.exe', 'datagrip64.exe', 'rustrover64.exe'];

/** The Windows app for the bundle id agentd records (Claude Desktop's for a desktop session), or Windows Terminal's
 *  package family name; null for any other. */
export function windowsApp(bundleId: string, env: Readonly<Record<string, string | undefined>> = process.env): WindowsApp | null {
  const local = env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local');
  const programs = env.ProgramFiles ?? 'C:\\Program Files';
  if (bundleId.startsWith('com.jetbrains.')) {
    // Toolbox installs each IDE in its own folder under Programs.
    return { name: 'JetBrains', exes: JETBRAINS_EXES, dirs: [win32.join(programs, 'JetBrains'), win32.join(local, 'Programs')] };
  }
  switch (bundleId) {
    case 'com.microsoft.VSCode':
      return { name: 'VS Code', exes: ['code.exe'], dirs: [win32.join(local, 'Programs', 'Microsoft VS Code'), win32.join(programs, 'Microsoft VS Code')] };
    case 'com.todesktop.230313mzl4w4u92':
      return { name: 'Cursor', exes: ['cursor.exe'], dirs: [win32.join(local, 'Programs', 'cursor')] };
    case DESKTOP_BUNDLE:
      return { name: 'Claude Desktop', exes: ['claude.exe'], dirs: [win32.join(local, 'AnthropicClaude')] };
    case 'Microsoft.WindowsTerminal':
      // A Store package under WindowsApps, which only its exe name finds.
      return { name: 'Windows Terminal', exes: ['windowsterminal.exe'], dirs: [] };
    default:
      return null;
  }
}

/** Activates the first running process of `app` that has a window. */
async function activateWindowsApp(ctx: OpsContext, app: WindowsApp): Promise<boolean> {
  const running = await helperResult(ctx, 'apps.running', { regular_only: true });
  const apps = Array.isArray(running.apps) ? running.apps as { pid?: unknown; app_id?: unknown; path?: unknown }[] : [];
  const dirs = app.dirs.map((d) => `${d.toLowerCase()}\\`);
  for (const a of apps) {
    const path = typeof a.path === 'string' ? a.path.toLowerCase() : '';
    const ours = app.exes.includes(win32.basename(path)) || app.exes.includes(String(a.app_id).toLowerCase()) || dirs.some((d) => path.startsWith(d));
    if (ours && typeof a.pid === 'number' && await activate(ctx, { pid: a.pid })) return true;
  }
  return false;
}

/** Desktop's own route only accepts ids of this shape. */
const isDesktopLocalId = (name: string) => /^local_[A-Za-z0-9-]{1,64}$/.test(name);

/** The Desktop `local_…` id whose record lists `cliSessionId`, reading only `root/*\/*\/local_*.json`. */
export function desktopLocalId(cliSessionId: string, root: string): string | null {
  const list = (dir: string) => {
    try {
      return readdirSync(dir).map((name) => join(dir, name));
    } catch {
      return [];
    }
  };
  for (const first of list(root)) {
    for (const second of list(first)) {
      for (const file of list(second)) {
        if (extname(file) !== '.json') continue;
        const name = file.slice(second.length + 1, -'.json'.length);
        if (!isDesktopLocalId(name)) continue;
        let record: { cliSessionId?: unknown; priorCliSessionIds?: unknown };
        try {
          record = JSON.parse(readFileSync(file, 'utf8')) as typeof record;
        } catch {
          continue;
        }
        if (record.cliSessionId === cliSessionId || (Array.isArray(record.priorCliSessionIds) && record.priorCliSessionIds.includes(cliSessionId))) {
          return name;
        }
      }
    }
  }
  return null;
}

/** Switches the most recently active client to `pane`; its pid, or why not. */
async function switchTmux(commands: Commands, socket: string, pane: string): Promise<{ pid: number } | { text: string }> {
  const tmux = commands.executable(['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']);
  if (tmux === null) return { text: '没找到 tmux' };
  const listed = await commands.run(tmux, ['-S', socket, 'list-clients', '-F', '#{client_tty} #{client_pid} #{client_activity}']);
  if (!listed.ok) return { text: `tmux 出错：${listed.message}` };
  let client: { tty: string; pid: number; activity: number } | null = null;
  for (const line of listed.stdout.split('\n')) {
    const parts = line.split(' ').filter((p) => p !== '');
    if (parts.length !== 3 || !/^-?\d+$/.test(parts[1]!) || !/^-?\d+$/.test(parts[2]!)) continue;
    const c = { tty: parts[0]!, pid: Number(parts[1]), activity: Number(parts[2]) };
    if (client === null || client.activity < c.activity) client = c;
  }
  if (client === null) return { text: 'tmux 会话没有连接的终端' };
  const switched = await commands.run(tmux, ['-S', socket, 'switch-client', '-c', client.tty, '-t', pane]);
  if (!switched.ok) return { text: `tmux 切换失败：${switched.message}` };
  return { pid: client.pid };
}

async function runThenActivate(ctx: OpsContext, commands: Commands, name: string, candidates: string[], args: string[], bundleId: string):
  Promise<string> {
  const path = commands.executable(candidates);
  const result: RunResult = path === null ? { ok: false, message: `没找到 ${name} 的命令行工具` } : await commands.run(path, args);
  if (!result.ok) return `${name} 切换失败：${result.message}`;
  return (await activate(ctx, { app_id: bundleId })) ? JUMPED : `已切换 ${name} 窗格，但没能激活 ${name}`;
}

/** Only to a running app (an Apple event would launch it), then the helper's `terminal.focus`. */
async function focusTerminal(ctx: OpsContext, name: string, bundleId: string, params: Record<string, unknown>): Promise<string> {
  const running = await helperResult(ctx, 'apps.running', {});
  const apps = Array.isArray(running.apps) ? running.apps as { app_id?: unknown }[] : [];
  if (!apps.some((a) => a.app_id === bundleId)) return `${name} 没在运行`;
  const r = await helperReply(ctx, 'terminal.focus', params, ['automation_denied', 'not_found', 'script_failed']);
  if (!r.ok && r.error.code === 'automation_denied') return `需要在系统设置里允许 Agentic Complex 控制 ${name}`;
  if (!r.ok && r.error.code === 'script_failed') return `${name} 出错：${r.error.message}`;
  return r.ok && r.result.focused === true ? JUMPED : `${name} 里没找到该会话`;
}

export async function jump(ctx: OpsContext, plan: JumpPlan): Promise<string> {
  const commands = ctx.commands ?? systemCommands;
  const windows = ctx.platform === 'windows';
  switch (plan.kind) {
    case 'desktop': {
      const sessions = windows ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions')
        : join(homedir(), 'Library/Application Support/Claude/claude-code-sessions');
      const localId = desktopLocalId(plan.cliSessionId, sessions);
      if (localId !== null) {
        try {
          // Undocumented Desktop route found in its app bundle; a later Desktop version may drop it.
          await ctx.shell.openExternal(`claude://code/continue?session=${localId}`);
          return JUMPED;
        } catch { /* activates Desktop below */ }
      }
      const activated = windows ? await activateWindowsApp(ctx, windowsApp(DESKTOP_BUNDLE)!) : await activate(ctx, { app_id: DESKTOP_BUNDLE });
      return activated ? 'Desktop 没找到该会话，已激活 Desktop' : 'Claude Desktop 没在运行';
    }
    case 'tmux': {
      const r = await switchTmux(commands, plan.socket, plan.pane);
      if ('text' in r) return r.text;
      return (await activate(ctx, { pid: r.pid, ancestors: true })) ? JUMPED : '已切换 tmux 窗格，但没找到外层终端';
    }
    case 'wezterm':
      return runThenActivate(ctx, commands, 'WezTerm', ['/Applications/WezTerm.app/Contents/MacOS/wezterm', '/opt/homebrew/bin/wezterm'],
        ['cli', 'activate-pane', '--pane-id', plan.pane], 'com.github.wez.wezterm');
    case 'kitty':
      return runThenActivate(ctx, commands, 'kitty', ['/Applications/kitty.app/Contents/MacOS/kitten', '/opt/homebrew/bin/kitten'],
        ['@', '--to', plan.listenOn, 'focus-window', '--match', `id:${plan.windowId}`], 'net.kovidgoyal.kitty');
    case 'terminalTTY':
      return focusTerminal(ctx, 'Terminal', 'com.apple.Terminal', { app: 'terminal', tty: plan.tty });
    case 'iTermTTY':
      return focusTerminal(ctx, 'iTerm', 'com.googlecode.iterm2', { app: 'iterm', tty: plan.tty });
    case 'ghostty':
      return focusTerminal(ctx, 'Ghostty', 'com.mitchellh.ghostty', { app: 'ghostty', cwd: plan.cwd });
    case 'activateBundle': {
      const app = windows ? windowsApp(plan.bundleId) : null;
      if (app !== null) return (await activateWindowsApp(ctx, app)) ? JUMPED : `${app.name} 没在运行`;
      return (await activate(ctx, { app_id: plan.bundleId })) ? JUMPED : `${plan.bundleId} 没在运行`;
    }
    case 'activatePid':
      return (await activate(ctx, { pid: plan.pid, ancestors: true })) ? JUMPED : `没找到进程 ${plan.pid} 所在的 app`;
  }
}
