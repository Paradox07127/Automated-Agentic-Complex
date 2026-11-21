// Carries out one ring item through the bridge; every item ends in a closed panel, a receipt or 快速输入.
import type { DesktopState, AgenticComplexBridge } from '../../../../bridge';
import { formatClock, type Severity } from '../../../../domain';
import { failureText } from '../../../../domain/errorText';
import { navRoute } from '../../../../shell/nav';
import type { CmdItem } from '../actions';

export type Outcome = { kind: 'close' } | { kind: 'receipt'; text: string; tone: Severity } | { kind: 'input' };

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

export async function runCmdAction(item: CmdItem, { bridge, state, now }: RunContext): Promise<Outcome> {
  const keys = state?.hotkeys ?? {};
  try {
    switch (item.id) {
      case 'input':
        return { kind: 'input' };
      case 'look':
        await bridge.app.look();
        return CLOSE;
      case 'goChat':
        if (item.to) bridge.window.openMain(navRoute(item.to));
        return CLOSE;
      case 'openStack':
      case 'show':
        await bridge.desktop.action(item.id);
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
      case 'gift':
        await bridge.desktop.action('gift');
        return receipt('已送出礼物');
    }
  } catch (e) {
    return receipt(`${item.label}没有完成：${failure(e)}`, 'danger');
  }
}
