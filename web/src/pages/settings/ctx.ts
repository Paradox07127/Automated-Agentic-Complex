import { createContext, useContext } from 'react';
import type { Capabilities, PermissionKind, PermissionState } from '../../bridge';
import type { Run } from '../../domain';
import { fromRuntimePublic } from '../../domain/adapt';
import type { WireRuntimePublic } from '../../domain/wire';
import type { BlockedLine, DayEvent, DiagView } from './diag';
import type { PermRow } from './perms';
import type { SettingsModel } from './model';
import type { Native, SchemaRow } from './native';
import type { GroupId } from './registry';
import type { WireBlacklist, WireModelSettings, WireScope } from './wire';
import type { Go } from '../../shell/nav';

/** `/character/runtime` as one row per backend, with the reply it came from. */
export type RuntimeView = ReturnType<typeof fromRuntimePublic> & { wire: WireRuntimePublic };

export const runtimeView = (w: WireRuntimePublic): RuntimeView => ({ ...fromRuntimePublic(w), wire: w });

export type Reloadable = 'runtime' | 'models' | 'diag' | 'blacklist' | 'scopes';

/** Everything a settings group needs besides its own rows. */
export interface SettingsCtxValue {
  model: SettingsModel;
  /** This group is read-only (agentd down for an agentd group, or config.json unreadable for a native one). */
  ro: boolean;
  /** Why the group is read-only, as the bar above it says. */
  roReason?: string;
  agentdOff: boolean;
  /** Row id flashing after a deep link. */
  hl: string | null;
  demo: string | null;
  /** `?item=` from the URL. */
  item: string | null;
  caps: Readonly<Capabilities>;
  /** config.json rows from the shell; null until read or when it cannot be read. */
  native: Native | null;
  /** The native schema alone, which still reads when config.json does not (option labels of a read-only group). */
  schema?: Record<string, SchemaRow> | null;
  runtime: RuntimeView | null;
  runtimeChecking: boolean;
  recheckRuntime: () => Promise<RuntimeView | null>;
  models: WireModelSettings | null;
  diag: DiagView;
  blacklist: WireBlacklist | null;
  scopes: WireScope[] | null;
  /** `/agent/runs`, newest first. */
  runs: Run[] | null;
  /** Today's screenshots and gate decisions; null until read or when the read failed. */
  shots?: DayEvent[] | null;
  gateEvents?: DayEvent[] | null;
  gateBlocked?: BlockedLine[] | null;
  reload: (what: Reloadable) => void;
  perms: PermRow[];
  recheckPerms: (kind?: PermissionKind) => Promise<PermissionState | null>;
  /** Jump to a row, switching group when needed. */
  goRow: (id: string, group?: GroupId) => void;
  /** Leave settings for another page. */
  goPage: Go;
}

export const SettingsCtx = createContext<SettingsCtxValue | null>(null);

export function useSettings(): SettingsCtxValue {
  const v = useContext(SettingsCtx);
  if (!v) throw new Error('useSettings outside SettingsCtx');
  return v;
}
