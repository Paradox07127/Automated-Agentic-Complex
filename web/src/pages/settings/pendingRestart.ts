import type { SettingValue } from '../../bridge';

/** A row saved but waiting for a backend restart: when it was last saved, and the value the running backend has (`old`). */
export interface Pending {
  at: number;
  old: SettingValue;
}

/** The rows waiting for a backend restart; kept across pages and reloads. */
export const PENDING_KEY = 'ef.settings.pendingRestart';

export function loadPending(): Record<string, Pending> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, Pending] => typeof e[1]?.at === 'number' && e[1].old != null));
  } catch {
    return {};
  }
}
