// `permissions.*`: the system grants the platform helper reads and asks for,
// and the system settings page of each. Notifications are not the helper's (C12 §7.9), and Electron reads no grant of them:
// macOS has the grant, read as not determined; Windows asks for none.
import { BridgeFailure } from '../../common/bridge.ts';
import type { ShellPlatform } from '../../common/config.ts';
import type { Ops, OpsContext } from './context.ts';

export const PERMISSION_KINDS = ['accessibility', 'screenRecording', 'microphone', 'automation', 'inputMonitoring', 'notifications'];
/** The five C12 `permissions.status` reads. */
const HELPER_KINDS = PERMISSION_KINDS.slice(0, 5);

type WebState = 'granted' | 'denied' | 'notDetermined' | 'unsupported';

/** A helper reading as protocol.ts `PermissionState`. */
function webState(kind: string, reading: unknown): WebState {
  if (reading === 'notApplicable') return 'unsupported';
  // The system cannot tell a refused screen recording or accessibility grant from one never asked.
  if (kind === 'screenRecording' || kind === 'accessibility') return reading === 'granted' ? 'granted' : 'notDetermined';
  return reading === 'granted' || reading === 'denied' || reading === 'notDetermined' ? reading : 'unsupported';
}

/** `permissions.status`' result, or null when the helper did not answer. */
export async function helperStatus(ctx: OpsContext): Promise<Record<string, unknown> | null> {
  if (!ctx.helper) return null;
  const reply = await ctx.helper.request('permissions.status', {});
  if (reply.ok) return reply.result;
  ctx.log(`helper permissions.status failed code=${reply.error.code}`);
  return null;
}

/** `permissions.request` for one of the helper's kinds; its state, or null when the helper did not answer. */
export async function helperRequest(ctx: OpsContext, kind: string): Promise<unknown> {
  if (!ctx.helper) return null;
  const reply = await ctx.helper.request('permissions.request', { kind });
  if (reply.ok) return reply.result.state;
  ctx.log(`helper permissions.request kind=${kind} failed code=${reply.error.code}`);
  return null;
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
  const notifications: WebState = mac ? 'notDetermined' : 'unsupported';
  // Windows has a grant for the microphone only (C12 §7.9), so the page lists no other.
  const kinds = mac ? PERMISSION_KINDS : ['microphone'];
  return {
    'permissions.status': async () => {
      const status = await helperStatus(ctx);
      return Object.fromEntries(kinds.map((k) => [k, k === 'notifications' ? notifications
        : status && HELPER_KINDS.includes(k) ? webState(k, status[k]) : 'unsupported']));
    },
    'permissions.request': async ([kind]) => {
      if (typeof kind !== 'string' || !PERMISSION_KINDS.includes(kind)) throw new BridgeFailure('invalid_args', 'permission kind');
      if (!HELPER_KINDS.includes(kind)) return notifications;
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
