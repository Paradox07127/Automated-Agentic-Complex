// Each `/feed` `command` is carried out as it comes, `open` an installed app
// the helper lists, `jump` to a session or a running app; a target that is not found or does not open is a notice.
import { feedCommand, type FeedCommand } from '../../common/commands.ts';
import type { StreamEvent } from '../../common/page.ts';
import { jumpPlan, matchApp, matchSession, parseSessions, type SessionInfo } from '../../common/session-jump.ts';
import { activate, helperResult, jump } from '../ops/jump.ts';
import { sessionsRoute } from '../ops/open.ts';
import type { OpsContext } from '../ops/context.ts';

export interface FeedCommandOptions {
  /** The helper, agentd and shell the ops use; the jump goes through them as `open.jumpToSession` does. */
  ctx: OpsContext;
  /** The stack's notice line (WebStack.notice). */
  notice(text: string): void;
  /** The companion log. */
  log(line: string): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Another action does nothing. */
async function run(o: FeedCommandOptions, c: FeedCommand): Promise<void> {
  const { ctx } = o, { action, target } = c;
  const done = (result: string) => o.log(`FEED command action=${action} result=${result}`);
  const fail = (text: string, result: string) => {
    o.notice(text);
    done(result);
  };
  if (action === 'open') {
    const installed = await helperResult(ctx, 'apps.installed', {});
    const apps = (Array.isArray(installed.apps) ? installed.apps : []).filter(isObject)
      .filter((a) => typeof a.path === 'string').map((a) => ({ path: a.path as string, displayName: typeof a.name === 'string' ? a.name : '' }));
    const path = matchApp(target, apps);
    if (path === null) return fail(`没找到应用「${target}」`, 'not_found');
    if ((await ctx.shell.openPath(path)) !== '') return fail(`打不开「${target}」`, 'open_failed');
    return done('opened');
  }
  if (action !== 'jump') return;
  let sessions: SessionInfo[] = [];
  try {
    const reply = await ctx.agentd?.request('GET', '/sessions');
    if (reply?.status === 200) sessions = parseSessions(JSON.parse(reply.body.toString('utf8')));
  } catch { /* no sessions, so the running apps below */ }
  const s = matchSession(target, sessions);
  if (s?.own && ctx.openMain) {
    ctx.openMain(sessionsRoute(s.sessionId), false);
    return done(`session_panel selected=${s.sessionId}`);
  }
  const plan = s && jumpPlan(s);
  if (plan) {
    const text = await jump(ctx, plan);
    return done(`session_jump note=${text}`);
  }
  // The match comes back as a path, so every candidate needs a distinct one.
  const running = await helperResult(ctx, 'apps.running', { regular_only: true });
  const apps = (Array.isArray(running.apps) ? running.apps : []).filter(isObject)
    .filter((a) => a.regular !== false && typeof a.path === 'string' && Number.isInteger(a.pid));
  const path = matchApp(target, apps.map((a) => ({ path: a.path as string, displayName: typeof a.name === 'string' ? a.name : '' })));
  const app = apps.find((a) => a.path === path);
  if (path !== null && app) {
    await activate(ctx, { pid: app.pid });
    return done('activated');
  }
  fail(`没找到「${target}」`, 'not_found');
}

/** The `/feed` subscriber (AgentStore.subscribe); a helper that fails the command is logged. */
export function feedCommands(o: FeedCommandOptions): (e: StreamEvent) => void {
  return (e) => {
    const c = feedCommand(e);
    if (c === null) return;
    void run(o, c).catch((error: unknown) =>
      o.log(`FEED command action=${c.action} failed: ${error instanceof Error ? error.message : String(error)}`));
  };
}
