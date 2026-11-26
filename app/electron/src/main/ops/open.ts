// `open.*`: URLs, artifacts and Finder; jumping to a session
// through the platform helper; running a confirmed command in Terminal.
import { realpathSync, statSync } from 'node:fs';
import { extname, normalize } from 'node:path';
import { BridgeFailure } from '../../common/bridge.ts';
import {
  appleScriptError, jumpPlan, parseSessions, runInTerminalScript, type SessionInfo,
} from '../../common/session-jump.ts';
import { localPath } from '../platform/index.ts';
import type { Ops, OpsContext } from './context.ts';
import { jump, JUMPED, systemCommands } from './jump.ts';

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

/** The sessions page's route, on session `id` when given: a hash route without `#`. */
export function sessionsRoute(id?: string): string {
  return id === undefined ? '/overview?focus=running' : `/overview?sel=${encodeURIComponent(id)}&focus=task-${encodeURIComponent(id)}`;
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
        throw new BridgeFailure('failed', '文件可能已被移动、删除或替换，请让角色重新检查结果。');
      }
      return null;
    },
    'open.revealInFinder': ([path]) => {
      if (typeof path !== 'string' || !localPath(path)) throw new BridgeFailure('invalid_args', 'an absolute path');
      if (!exists(path)) throw new BridgeFailure('failed', '找不到该文件或文件夹');
      ctx.shell.showItemInFolder(path);
      return null;
    },
    'open.jumpToSession': async ([id], page) => {
      if (typeof id !== 'string' || id === '' || Buffer.byteLength(id) > 256) throw new BridgeFailure('invalid_args', 'session id');
      let list: SessionInfo[];
      try {
        list = await sessions(ctx);
      } catch {
        throw new Error('后台服务无响应，暂时无法跳转');
      }
      const session = list.find((s) => s.sessionId === id);
      if (!session) throw new Error('未找到该会话');
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
      if (!plan) throw new Error('当前会话无可用跳转方式');
      const text = await jump(ctx, plan);
      if (text !== JUMPED) throw new Error(text);
      return null;
    },
    /** The checks, the confirmation, then Terminal through osascript. */
    'open.runInTerminal': async ([command]) => {
      // Bidi and line-separator marks would make the confirmation show another command than the one run.
      if (typeof command !== 'string' || command === '' || Buffer.byteLength(command) > 4096 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command)) {
        throw new BridgeFailure('invalid_args', 'a one-line command');
      }
      if ((ctx.platform ?? 'mac') !== 'mac') throw new Error('当前系统暂不支持在终端中执行命令');
      if (!(await ctx.confirm(`确认在终端运行以下命令？\n\n${command}`))) throw new BridgeFailure('declined', 'open.runInTerminal');
      // It may wait on the Automation prompt or on Terminal starting.
      const result = await (ctx.commands ?? systemCommands).run('/usr/bin/osascript', ['-e', runInTerminalScript(command)], null);
      if (result.ok) return null;
      const number = appleScriptError(result.message);
      if (number === -1743) throw new Error('请在系统设置中允许 Agentic Complex 控制终端');
      throw new Error(`Terminal 出错：${number ?? 'unknown'}`);
    },
  };
}
