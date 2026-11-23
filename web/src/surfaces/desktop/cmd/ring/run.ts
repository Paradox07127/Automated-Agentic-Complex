// Carries out one wheel item (or one of the console's switches) through the bridge; every item ends in a closed panel or a receipt.
import type { DesktopState, AgenticComplexBridge } from '../../../../bridge';
import { formatClock, type Severity } from '../../../../domain';
import { failureText } from '../../../../domain/errorText';
import { navRoute, type NavTarget } from '../../../../shell/nav';
import type { CmdActionId, CmdLevel } from '../actions';

export type Outcome = { kind: 'close' } | { kind: 'receipt'; text: string; tone: Severity };

/** A wheel item that runs (动作 and 姿态 open a level instead), or the console's 显示角色 switch. */
export interface RunItem {
  id: Exclude<CmdActionId, CmdLevel> | 'hide' | 'show';
  label: string;
  to?: NavTarget;
  /** A dance's index in her saved setlist. */
  start?: number;
  /** A pose's row id, null for 自动. */
  pose?: string | null;
}

export interface RunContext {
  bridge: AgenticComplexBridge;
  state: DesktopState | null;
  now: () => number;
}

const MINUTE = 60_000;
const CLOSE: Outcome = { kind: 'close' };
const receipt = (text: string, tone: Severity = 'success'): Outcome => ({ kind: 'receipt', text, tone });

/** The `{code, detail}` a rejected bridge op carries. */
function failure(e: unknown): string {
  const err = e as { code?: unknown; detail?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code : null;
  const detail = typeof err?.detail === 'string' ? err.detail : null;
  return failureText({ status: 0, code, detail }).text;
}

export async function runCmdAction(item: RunItem, { bridge, state, now }: RunContext): Promise<Outcome> {
  const keys = state?.hotkeys ?? {};
  try {
    switch (item.id) {
      case 'goChat':
      case 'pending':
      case 'goCharacter':
        if (item.to) bridge.window.openMain(navRoute(item.to));
        return CLOSE;
      case 'show':
        await bridge.desktop.action('show');
        return CLOSE;
      case 'hide':
        await bridge.desktop.action('hide');
        return receipt(`角色已隐藏 30 分钟 │ ${formatClock(now() + 30 * MINUTE)} 回来${keys.hk_hide ? ` │ ${keys.hk_hide} 显示` : ''}`);
      case 'pass':
        await bridge.desktop.action('clickThroughAll');
        return receipt(state?.clickThroughAll ? '全部点穿已结束' : `临时全部点穿已开启${keys.hk_pass ? ` │ ${keys.hk_pass} 关闭` : ''}`);
      case 'quiet':
        await bridge.desktop.action('quiet');
        return receipt(`免打扰已开始 │ ${formatClock(now() + 30 * MINUTE)} 恢复`);
      case 'quietEnd':
        await bridge.desktop.action('quietEnd');
        return receipt('免打扰已结束');
      case 'home':
        await bridge.desktop.action('resetPosition');
        await bridge.desktop.action('resetBoxes');
        return CLOSE;
      case 'roam':
        await bridge.desktop.action('freeRoam');
        return receipt(state?.freeRoam ? '自由活动已关闭' : '自由活动已开启');
      case 'gift':
        await bridge.desktop.action('gift');
        return CLOSE;
      case 'stop':
        await bridge.desktop.action('stopPlay');
        return receipt('动作已停止');
      case 'dance': {
        // The list plays on from this dance with its own loop setting.
        const r = await bridge.avatar.playPlaylist({ start: item.start ?? 0 });
        return r.ok ? CLOSE : receipt(`${item.label}没有开始：${r.reason === 'empty' ? '列表里没有这支舞' : '角色没有接受'}`, 'danger');
      }
      case 'pose':
        await bridge.desktop.action('pose', item.pose ?? undefined);
        return CLOSE;
    }
  } catch (e) {
    return receipt(`${item.label}没有完成：${failure(e)}`, 'danger');
  }
}
