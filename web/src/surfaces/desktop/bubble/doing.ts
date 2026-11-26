// The bubble's 正在做 row from agentd's `/desktop/presence` `role` (`role.doing`).
import { ACTIVE, readPresence, stateLabel } from '../tags/presence';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export interface Doing {
  text: string;
  /** Epoch seconds her run began; null while she is idle. */
  since: number | null;
}

/** `role.doing` first; an agentd without it gives the intention or state word while she runs, her activity while idle. */
export function doingOf(raw: unknown): Doing {
  const presence = readPresence(raw);
  if (presence.offline) return { text: '连不上后台', since: null };
  const role = obj(obj(raw)?.role);
  const view = presence.role;
  const doing = str(role?.doing);
  if (view && ACTIVE.has(view.state)) return { text: doing ?? view.intention ?? stateLabel(view.state), since: view.since };
  return { text: doing ?? str(role?.activity) ?? stateLabel(view?.state ?? 'idle'), since: null };
}
