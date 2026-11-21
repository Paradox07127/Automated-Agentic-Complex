// `open.*`: URLs, artifacts and Finder; jumping to a session and feed commands
// through the platform helper; running a confirmed command in Terminal.
import { realpathSync, statSync } from 'node:fs';
import { extname, normalize } from 'node:path';
import { BridgeFailure } from '../../common/bridge.ts';
import {
  appleScriptError, jumpPlan, matchApp, matchSession, parseSessions, runInTerminalScript, type SessionInfo,
} from '../../common/session-jump.ts';
import { localPath } from '../platform/index.ts';
import type { Ops, OpsContext } from './context.ts';
import { activate, helperResult, jump, JUMPED, systemCommands } from './jump.ts';

/** An absolute text deliverable (md, txt, csv, json) that is a regular, non-executable file
 *  reached without symlinks. */
function existingArtifact(path: string): string | null {
  if (!localPath(path) || !['.md', '.txt', '.csv', '.json'].includes(extname(path).toLowerCase())) return null;
  try {
    if (realpathSync(path) !== normalize(path)) return null;
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) === 0 ? path : null;
  } catch {
    return null;
  }
}

const exists = (path: string) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Throws when agentd does not answer 200 with sessions that decode. */
async function sessions(ctx: OpsContext): Promise<SessionInfo[]> {
  if (!ctx.agentd) throw new Error('agentd is unreachable');
  const reply = await ctx.agentd.request('GET', '/sessions');
  if (reply.status !== 200) throw new Error(`GET /sessions status=${reply.status}`);
  return parseSessions(JSON.parse(reply.body.toString('utf8')));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The sessions page's route, on session `id` when given: a hash route without `#`. */
export function sessionsRoute(id?: string): string {
  return id === undefined ? '/overview?focus=running' : `/overview?sel=${encodeURIComponent(id)}&focus=task-${encodeURIComponent(id)}`;
}

/** Null when the command was carried out, else why not. */
async function feedCommand(ctx: OpsContext, action: 'open' | 'jump', target: string): Promise<string | null> {
  const done = (result: string, failure: string | null) => {
    ctx.log(`FEED command action=${action} result=${result}`);
    return failure;
  };
  if (action === 'open') {
    const installed = await helperResult(ctx, 'apps.installed', {});
    const apps = (Array.isArray(installed.apps) ? installed.apps : []).filter(isObject)
      .filter((a) => typeof a.path === 'string').map((a) => ({ path: a.path as string, displayName: typeof a.name === 'string' ? a.name : '' }));
    const path = matchApp(target, apps);
    if (path === null) return done('not_found', `没找到应用「${target}」`);
    if ((await ctx.shell.openPath(path)) !== '') return done('open_failed', `打不开「${target}」`);
    return done('opened', null);
  }
  let list: SessionInfo[] = [];
  try {
    list = await sessions(ctx);
  } catch { /* no sessions: the running apps below */ }
  const s = matchSession(target, list);
  // The agent's entry, so a focused main window keeps its page.
  if (s?.own && ctx.openMain) {
    ctx.openMain(sessionsRoute(s.sessionId), false);
    return done(`session_panel selected=${s.sessionId}`, null);
  }
  const plan = s && jumpPlan(s);
  if (plan) {
    const text = await jump(ctx, plan);
    return done(`session_jump note=${text}`, text === JUMPED ? null : text);
  }
  // The match comes back as a path, so every candidate needs a distinct one.
  const running = await helperResult(ctx, 'apps.running', { regular_only: true });
  const apps = (Array.isArray(running.apps) ? running.apps : []).filter(isObject)
    .filter((a) => a.regular !== false && typeof a.path === 'string' && Number.isInteger(a.pid));
  const path = matchApp(target, apps.map((a) => ({ path: a.path as string, displayName: typeof a.name === 'string' ? a.name : '' })));
  const app = apps.find((a) => a.path === path);
  if (path !== null && app) {
    await activate(ctx, { pid: app.pid });
    return done('activated', null);
  }
  return done('not_found', `没找到「${target}」`);
}

export function openOps(ctx: OpsContext): Ops {
  return {
    'open.url': async ([text]) => {
      let url: URL | null = null;
      if (typeof text === 'string' && new TextEncoder().encode(text).length <= 2048) {
        try {
          url = new URL(text);
        } catch { /* refused below */ }
      }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.hostname === '') {
        throw new BridgeFailure('invalid_args', 'an http(s) URL');
      }
      await ctx.shell.openExternal(url.href);
      return null;
    },
    'open.artifact': async ([path]) => {
      if (typeof path !== 'string') throw new BridgeFailure('invalid_args', 'path');
      const file = existingArtifact(path);
      if (file === null || (await ctx.shell.openPath(file)) !== '') {
        throw new BridgeFailure('failed', '文件可能已被移动、删除或替换。请让角色重新检查结果。');
      }
      return null;
    },
    'open.revealInFinder': ([path]) => {
      if (typeof path !== 'string' || !localPath(path)) throw new BridgeFailure('invalid_args', 'an absolute path');
      if (!exists(path)) throw new BridgeFailure('failed', '找不到这个文件或文件夹');
      ctx.shell.showItemInFolder(path);
      return null;
    },
    'open.jumpToSession': async ([id], page) => {
      if (typeof id !== 'string' || id === '' || Buffer.byteLength(id) > 256) throw new BridgeFailure('invalid_args', 'session id');
      let list: SessionInfo[];
      try {
        list = await sessions(ctx);
      } catch {
        throw new Error('后台没有回应，暂时跳不过去');
      }
      const session = list.find((s) => s.sessionId === id);
      if (!session) throw new Error('没找到这个会话');
      // An own session opens on the main window's sessions route.
      if (session.own && ctx.surface === 'main') {
        page.pushRoute(sessionsRoute(id));
        return null;
      }
      if (session.own && ctx.openMain) {
        ctx.openMain(sessionsRoute(id));
        return null;
      }
      const plan = jumpPlan(session);
      if (!plan) throw new Error('没有可用的跳转方式');
      const text = await jump(ctx, plan);
      if (text !== JUMPED) throw new Error(text);
      return null;
    },
    'open.runFeedCommand': async ([command]) => {
      const c = isObject(command) ? command : {};
      const { action, target } = c;
      if ((action !== 'open' && action !== 'jump') || typeof target !== 'string' || target === '' || Buffer.byteLength(target) > 1024) {
        throw new BridgeFailure('invalid_args', '{action: open|jump, target}');
      }
      const failure = await feedCommand(ctx, action, target);
      if (failure !== null) throw new Error(failure);
      return null;
    },
    /** The checks, the confirmation, then Terminal through osascript. */
    'open.runInTerminal': async ([command]) => {
      // Bidi and line-separator marks would make the confirmation show another command than the one run.
      if (typeof command !== 'string' || command === '' || Buffer.byteLength(command) > 4096 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)) {
        throw new BridgeFailure('invalid_args', 'a one-line command');
      }
      if ((ctx.platform ?? 'mac') !== 'mac') throw new Error('这个系统上还不能在终端里运行命令');
      if (!(await ctx.confirm(`在终端运行这条命令？\n\n${command}`))) throw new BridgeFailure('declined', 'open.runInTerminal');
      // It may wait on the Automation prompt or on Terminal starting.
      const result = await (ctx.commands ?? systemCommands).run('/usr/bin/osascript', ['-e', runInTerminalScript(command)], null);
      if (result.ok) return null;
      const number = appleScriptError(result.message);
      if (number === -1743) throw new Error('需要在系统设置里允许 Agentic Complex 控制 Terminal');
      throw new Error(`Terminal 出错：${number ?? 'unknown'}`);
    },
  };
}
