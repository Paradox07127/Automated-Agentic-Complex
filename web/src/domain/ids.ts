// Id formats agentd uses (canonical task ids, delivery ids). Put an id into a path with `seg()` (bridge/agentd.ts).

/** `/agent/tasks` canonical_task_id: `job:<32hex>` or `task:<ledger id>`. */
export type CanonicalTaskId = `job:${string}` | `task:${string}`;

/** Task row key in the web: a canonical id, or `ext:<display_session>` for an external session; ext ids never go to agentd. */
export type TaskKey = CanonicalTaskId | `ext:${string}`;

/** `delivery-<32hex>`. */
export type DeliveryId = `delivery-${string}`;

export const toCanonical = (ledgerId: string): CanonicalTaskId => `task:${ledgerId}`;

export function splitCanonical(id: TaskKey): { kind: 'job' | 'task' | 'ext'; raw: string } {
  const at = id.indexOf(':');
  return { kind: id.slice(0, at) as 'job' | 'task' | 'ext', raw: id.slice(at + 1) };
}

export const isAgentdTask = (id: string): id is CanonicalTaskId => id.startsWith('job:') || id.startsWith('task:');
