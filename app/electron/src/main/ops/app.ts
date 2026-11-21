// `app.info`, `app.action`, `app.look`, `app.openQuickInput`, `app.runtime` and `app.onRuntime`.
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { stateText } from '../../common/agentd.ts';
import { BridgeFailure } from '../../common/bridge.ts';
import type { ShellPlatform } from '../../common/config.ts';
import { diagnosticsText, errorLines } from '../../common/diagnostics.ts';
import { supportDirOf } from '../config.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';
import { slotText } from './supervisor.ts';

const ACTIONS = new Set(['restart_backend', 'reveal_logs', 'copy_diagnostics', 'open_onboarding', 'open_data_folder', 'open_config',
  'test_approval_card', 'test_announcement']);

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/** `<devResources>/dev-receipt.json`, read at each call since a deployment replaces it; empty without
 *  one or with any of its four fields missing. */
function devReceipt(devResources: string | null): { devCommit: string; devDirty: boolean; devUiHash: string; devAgentdHash: string } {
  let r: unknown = null;
  try {
    r = devResources === null ? null : JSON.parse(readFileSync(join(devResources, 'dev-receipt.json'), 'utf8'));
  } catch { /* `try?` there: none */ }
  const o = typeof r === 'object' && r !== null ? r as Record<string, unknown> : {};
  return typeof o.commit === 'string' && typeof o.dirty === 'boolean' && typeof o.ui_sha256 === 'string' && typeof o.agentd_sha256 === 'string'
    ? { devCommit: o.commit, devDirty: o.dirty, devUiHash: o.ui_sha256, devAgentdHash: o.agentd_sha256 }
    : { devCommit: '', devDirty: false, devUiHash: '', devAgentdHash: '' };
}

/** The diagnostics' build: CFBundleVersion of `<contents>/Info.plist` (XML, as package_app.py writes it), on Windows (no Info.plist)
 *  the host component's `version`, the same build number; `?` without one, as with no packaged app (`contents` null). */
export function bundleBuild(contents: string | null, platform: ShellPlatform = 'mac'): string {
  if (contents === null) return '?';
  if (platform === 'windows') {
    let version: unknown;
    try {
      version = (JSON.parse(readText(join(contents, 'resources', 'components', 'host', 'component.json'))) as Record<string, unknown>).version;
    } catch { /* none */ }
    return typeof version === 'string' && version !== '' ? version : '?';
  }
  const plist = readText(join(contents, 'Info.plist'));
  return /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? '?';
}

export function appOps(ctx: OpsContext): Ops {
  const supportDir = () => {
    if (ctx.config.supportDir === null) throw new BridgeFailure('failed', '没有数据目录（配置出错）');
    return ctx.config.supportDir;
  };
  const opened = async (path: string) => {
    const error = await ctx.shell.openPath(path);
    if (error !== '') throw new BridgeFailure('failed', error);
  };
  const runtime = ctx.runtime;
  return {
    // Without a coordinator both answer not_implemented.
    ...(runtime && { 'app.runtime': () => runtime.snapshot(), 'app.onRuntime': watch('app.onRuntime', runtime.events) }),
    'app.look': async () => {
      if (!ctx.look) throw new BridgeFailure('offline', '屏幕识读不可用（配置出错）');
      const r = await ctx.look();
      switch (r.kind) {
        case 'requested': return { requestId: r.requestId };
        case 'blocked': throw new BridgeFailure('blocked', r.reason);
        case 'rejected': throw new BridgeFailure('failed', `POST /look status ${r.status} ${r.error}`);
        default: throw new BridgeFailure('offline', '');
      }
    },
    'app.info': () => {
      const hook = ctx.library?.hookCommand ?? '';
      return {
        version: ctx.app.version, buildGit: ctx.app.buildGit ?? '', os: ctx.app.os,
        loadAverage: loadavg()[0], cores: availableParallelism(), source: ctx.config.devResources === null ? 'bundle' : 'dev',
        ...devReceipt(ctx.config.devResources),
        hookInstallSteps: hook === '' ? [] : [{ label: '先看会改什么', command: `${hook} --dry-run`, terminal: true },
          { label: '确认改动后执行', command: hook, terminal: true }],
      };
    },
    'app.action': async ([name]) => {
      if (typeof name !== 'string') throw new BridgeFailure('invalid_args', 'action name');
      if (!ACTIONS.has(name)) throw new BridgeFailure('not_implemented', name);
      switch (name) {
        case 'restart_backend':
          if (!ctx.supervisor) throw new BridgeFailure('failed', '没有数据目录（配置出错）');
          ctx.supervisor.restart();
          return null;
        case 'reveal_logs':
          await opened(join(supportDir(), 'logs'));
          return null;
        case 'open_data_folder':
          await opened(supportDir());
          return null;
        case 'open_config':
          await opened(ctx.config.path);
          return null;
        case 'copy_diagnostics': {
          // Also while config.json does not load: the logs its error went to.
          const logs = join(ctx.config.supportDir ?? supportDirOf(ctx.config.path, dirname(ctx.config.path)), 'logs');
          const agentd = stateText(ctx.supervisor?.state() ?? { kind: 'stopped' });
          const avatar = stateText(ctx.supervisor?.avatar() ?? { kind: 'stopped' });
          const tunnel = slotText(ctx.supervisor?.tunnel?.() ?? { kind: 'stopped' });
          ctx.clipboard.writeText(diagnosticsText(ctx.app.version, ctx.app.build ?? '?', [['agentd', agentd], ['avatar', avatar], ['tunnel', tunnel]],
            errorLines(readText(join(logs, 'companion.log')), readText(join(logs, 'agentd.log')))));
          return null;
        }
        case 'test_approval_card':
        case 'test_announcement':
          if (!ctx.testCard) throw new BridgeFailure('not_implemented', name);
          if (!ctx.testCard(name === 'test_approval_card' ? 'approval' : 'announcement')) {
            throw new BridgeFailure('failed', '桌面卡片无法显示，请先显示角色');
          }
          return null;
        default:
          // open_onboarding
          if (!ctx.openOnboarding) throw new BridgeFailure('not_implemented', name);
          ctx.openOnboarding();
          return null;
      }
    },
    'app.openQuickInput': () => {
      if (!ctx.openQuickInput) throw new BridgeFailure('failed', '快速输入不可用（配置出错）');
      ctx.openQuickInput();
      return null;
    },
  };
}
