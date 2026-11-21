// agentd's `/feed` `command` event: the shell carries out `open` or `jump` of a target as spoken.

export interface FeedCommand { seq: number; action: string; target: string }

/** Null for another event or data that does not decode. */
export function feedCommand(e: { event: string; data: string }): FeedCommand | null {
  if (e.event !== 'command') return null;
  let v: unknown;
  try {
    v = JSON.parse(e.data);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { seq, action, target } = v as Record<string, unknown>;
  if (!Number.isInteger(seq) || typeof action !== 'string' || typeof target !== 'string') return null;
  return { seq: seq as number, action, target };
}
