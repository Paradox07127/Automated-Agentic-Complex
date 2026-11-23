// `permissions.*`: the system grants the platform helper reads and asks for,
// and the system settings page of each. macOS's notification grant is the app's, which Electron can neither read nor ask
// for: the helper does both (C12 §7.9). Windows has no notification grant.
import { BridgeFailure } from '../../common/bridge.ts';
import type { ShellPlatform } from '../../common/config.ts';
import type { PluginId } from '../../common/plugins.ts';
import type { Ops, OpsContext } from './context.ts';

export const PERMISSION_KINDS = ['accessibility', 'screenRecording', 'microphone', 'automation', 'inputMonitoring', 'notifications'];

type WebState = 'granted' | 'denied' | 'notDetermined' | 'unsupported';
type Helper = NonNullable<OpsContext['helper']>;

/** The kinds each helper was asked for; macOS shows its prompt only for the first request. */
const asked = new WeakMap<Helper, Set<string>>();

/** A helper reading as protocol.ts `PermissionState`. */
function webState(kind: string, reading: unknown, helper?: Helper | null): WebState {
  if (reading === 'notApplicable') return 'unsupported';
  // The system cannot tell a refused screen recording or accessibility grant from one never asked; one we asked for is refused.
  if (kind === 'screenRecording' || kind === 'accessibility') {
    return reading === 'granted' ? 'granted' : helper && asked.get(helper)?.has(kind) ? 'denied' : 'notDetermined';
  }
  return reading === 'granted' || reading === 'denied' || reading === 'notDetermined' ? reading : 'unsupported';
}

/** `permissions.status`' result, or null when the helper did not answer. */
export async function helperStatus(ctx: Pick<OpsContext, 'helper' | 'log'>): Promise<Record<string, unknown> | null> {
  if (!ctx.helper) return null;
  const reply = await ctx.helper.request('permissions.status', {});
  if (reply.ok) return reply.result;
  ctx.log(`helper permissions.status failed code=${reply.error.code}`);
  return null;
}

/** `permissions.request` for one of the helper's kinds; its state, or null when the helper did not answer. */
export async function helperRequest(ctx: Pick<OpsContext, 'helper' | 'log'>, kind: string): Promise<unknown> {
  if (!ctx.helper) return null;
  const reply = await ctx.helper.request('permissions.request', { kind });
  if (reply.ok) {
    asked.set(ctx.helper, (asked.get(ctx.helper) ?? new Set()).add(kind));
    return reply.result.state;
  }
  ctx.log(`helper permissions.request kind=${kind} failed code=${reply.error.code}`);
  return null;
}

/** The grants each plug-in's captures need, as the settings page's bands list them. */
const PLUGIN_GRANTS: Partial<Record<PluginId, string[]>> = {
  screen_awareness: ['accessibility', 'screenRecording'], screen_reading: ['screenRecording'], computer_use: ['accessibility', 'screenRecording'],
};

/** On macOS, has the helper, which captures, ask once for each grant `plugins` need and it lacks: its captures only check,
 *  so without this the system never shows its prompt nor lists the app. */
export async function askForPluginGrants(ctx: Pick<OpsContext, 'helper' | 'platform' | 'log'>, plugins: readonly string[]): Promise<void> {
  if ((ctx.platform ?? 'mac') !== 'mac') return;
  const kinds = [...new Set(plugins.flatMap((id) => PLUGIN_GRANTS[id as PluginId] ?? []))].sort();
  if (kinds.length === 0) return;
  const status = await helperStatus(ctx);
  if (status === null) return;
  for (const kind of kinds) if (status[kind] !== 'granted') await helperRequest(ctx, kind);
}

const SECURITY = 'x-apple.systempreferences:com.apple.preference.security?';
/** Each grant's system settings page; Windows' from C12 §7.9. */
const PANES: Record<ShellPlatform, Record<string, string>> = {
  mac: {
    screenRecording: `${SECURITY}Privacy_ScreenCapture`, accessibility: `${SECURITY}Privacy_Accessibility`,
    microphone: `${SECURITY}Privacy_Microphone`, automation: `${SECURITY}Privacy_Automation`,
    loginItems: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension', inputMonitoring: `${SECURITY}Privacy_ListenEvent`,
    notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  },
  windows: { microphone: 'ms-settings:privacy-microphone' },
};

/** Opens a protocol.ts `SystemSettingsPane`; throws when there is none or it did not open. */
export async function openSettings(ctx: OpsContext, pane: string): Promise<void> {
  const platform = ctx.platform ?? 'mac', url = PANES[platform][pane];
  // These two panes list the app only after it asked once.
  if (platform === 'mac' && (pane === 'screenRecording' || pane === 'accessibility')) await helperRequest(ctx, pane);
  try {
    if (url === undefined) throw new Error(`no page for ${pane}`);
    await ctx.shell.openExternal(url);
  } catch (e) {
    ctx.log(`open settings ${pane} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw new BridgeFailure('failed', '打不开系统设置');
  }
}

export function permissionsOps(ctx: OpsContext): Ops {
  const mac = (ctx.platform ?? 'mac') === 'mac';
  // Windows has a grant for the microphone only (C12 §7.9), so the page lists no other.
  const kinds = mac ? PERMISSION_KINDS : ['microphone'];
  return {
    'permissions.status': async () => {
      const status = await helperStatus(ctx);
      return Object.fromEntries(kinds.map((k) => [k, status ? webState(k, status[k], ctx.helper) : 'unsupported']));
    },
    'permissions.request': async ([kind]) => {
      if (typeof kind !== 'string' || !PERMISSION_KINDS.includes(kind)) throw new BridgeFailure('invalid_args', 'permission kind');
      if (!mac && kind === 'notifications') return 'unsupported';
      const state = await helperRequest(ctx, kind);
      return state === null ? 'unsupported' : webState(kind, state);
    },
    'permissions.openSettings': async ([pane]) => {
      if (typeof pane !== 'string' || !(PERMISSION_KINDS.includes(pane) || pane === 'loginItems')) {
        throw new BridgeFailure('invalid_args', 'settings pane');
      }
      await openSettings(ctx, pane);
      return null;
    },
  };
}
