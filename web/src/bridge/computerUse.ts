// `computerUse.*`: the scopes granted now for every surface, and the 电脑操作 panel's whole state and buttons for its page.
import type { ComputerUseScope, ComputerUseState, Unsubscribe } from './protocol';

export type ComputerUsePhase = 'disabled' | 'ready' | 'waitingPermission' | 'observing' | 'executing' | 'verifying' | 'paused'
  | 'completed' | 'failed';

/** One scope's state on the panel: `systemPermissionRequired` until the system permission is given. */
export type ComputerUseGrant = 'off' | 'allowed' | 'systemPermissionRequired' | 'unavailable';

/** What the native panel shows (ComputerUsePanelState); the host decides every field, the page only asks. */
export interface ComputerUsePanel {
  phase: ComputerUsePhase;
  targetApp: string | null;
  /** What it is doing, or what it waits for. */
  action: string;
  /** The window, the session and the grant's lifetime, at most 4. */
  scopeChips: string[];
  /** A scope that is not listed is `off`. */
  permissions: Partial<Record<ComputerUseScope, ComputerUseGrant>>;
  /** Scopes clicked and not yet confirmed by the host. */
  pendingGrants: ComputerUseScope[];
  showsPermissionChoices: boolean;
  canResume: boolean;
  /** The shown request's opaque id; null when none is shown. */
  challenge: string | null;
}

export interface ComputerUseOps {
  state(): Promise<ComputerUseState>;
  /** Asks for each scope that is not allowed yet, for the request `challenge` the page shows (`ComputerUsePanel.challenge`);
   *  native grants nothing when another request is shown now. Only the panel page is served. */
  grant(scopes: ComputerUseScope[], challenge: string | null): Promise<void>;
  /** Takes back each scope that is allowed, as `grant` for the shown `challenge`; only the panel page is served. */
  revoke(scopes: ComputerUseScope[], challenge: string | null): Promise<void>;
  stop(): Promise<void>;
  onState(cb: (s: ComputerUseState) => void): Unsubscribe;
  /** 继续 after the user took over; only the panel page is served. */
  resume(): Promise<void>;
  /** 收起: stops the task and hides the panel until a session asks again; only the panel page is served. */
  dismiss(): Promise<void>;
  /** The panel's state, the current one first; only the panel page is served. */
  onPanel(cb: (p: ComputerUsePanel) => void): Unsubscribe;
}
