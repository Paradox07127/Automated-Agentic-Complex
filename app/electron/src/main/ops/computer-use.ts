// `computerUse.state`, `computerUse.stop` and `computerUse.onState` over the computer control host (src/main/control/host.ts);
// without a host they answer `not_implemented`. The grant, resume and 收起 ops are the
// 电脑操作 panel's own (`computerUsePanelOps`, src/main/control/panel.ts): no other page of the stack surface has them.
import { BridgeFailure } from '../../common/bridge.ts';
import { type ComputerUsePanelState, computerUseState, type ControlPermission, grantState, PERMISSIONS } from '../../common/computer-control.ts';
import type { EventSource } from '../../common/page.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';

export interface ComputerUseHost {
  readonly state: ComputerUsePanelState;
  stopControl(): Promise<void>;
  readonly events: EventSource;
}

/** What the panel's buttons call. */
export interface PanelHost {
  readonly state: ComputerUsePanelState;
  /** A click on a permission's button: asks for it, or takes a granted one back; nothing unless `challenge` is the one shown
   *  now (`ComputerUsePanelState.challenge`). */
  grant(permission: ControlPermission, challenge: string | null): Promise<void>;
  resume(): Promise<void>;
  dismiss(): Promise<void>;
}

export function computerUseOps(ctx: OpsContext): Ops {
  const current = (op: string): ComputerUseHost => {
    if (!ctx.computerUse) throw new BridgeFailure('not_implemented', op);
    return ctx.computerUse;
  };
  return {
    'computerUse.state': () => computerUseState(current('computerUse.state').state),
    'computerUse.stop': () => {
      void current('computerUse.stop').stopControl();
      return null;
    },
    'computerUse.onState': (args, page) => watch('computerUse.onState', current('computerUse.onState').events)(args, page),
  };
}

function scopes(v: unknown): ControlPermission[] {
  if (!Array.isArray(v) || !v.every((p) => PERMISSIONS.includes(p as ControlPermission))) {
    throw new BridgeFailure('invalid_args', 'ComputerUseScope[]');
  }
  return v as ControlPermission[];
}

/** The panel page's ops: `grant` asks for each listed permission not allowed yet, `revoke` takes back each allowed one; both
 *  carry the challenge the page showed. */
export function computerUsePanelOps(host: PanelHost, panel: { readonly states: EventSource; dismiss(): Promise<void>;
  setContentSize(height: number): void }): Ops {
  const click = (list: ControlPermission[], challenge: unknown, allowed: boolean) => {
    const shown = typeof challenge === 'string' ? challenge : null;
    for (const p of list) if ((grantState(host.state, p) === 'allowed') === allowed) void host.grant(p, shown);
    return null;
  };
  return {
    'computerUse.grant': ([list, challenge]) => click(scopes(list), challenge, false),
    'computerUse.revoke': ([list, challenge]) => click(scopes(list), challenge, true),
    'computerUse.resume': () => {
      void host.resume();
      return null;
    },
    'computerUse.dismiss': () => {
      void panel.dismiss();
      return null;
    },
    'computerUse.onPanel': watch('computerUse.onPanel', panel.states),
    'window.setContentSize': ([s]) => {
      const o = s as Record<string, unknown> | null;
      const width = o?.width, height = o?.height;
      if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)
        || width <= 0 || height <= 0) throw new BridgeFailure('invalid_args', '{width, height}, finite and positive');
      panel.setContentSize(height);
      return null;
    },
  };
}
