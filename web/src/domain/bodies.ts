// Request bodies agentd's write routes take. Each takes the domain object so the concurrency field comes from the
// row the user saw; after a write, replace the cached row with the reply's (delivery revision and conversation
// revision go up by one on every write).
import type { Conversation, Fact } from './context';
import type { CharacterState } from './system';
import { msToEpochSec } from './units';
import type { WireRuntimeSettings } from './wire';
import type { ActiveRun, Approval, Delivery, Goal, Question } from './work';

/** POST /approvals/{id}/decision. `mode` only goes with a dispatch card; `message`, the user's reason, only with a deny. */
export function approvalDecision(a: Approval, decision: 'allow' | 'allow_session' | 'deny', mode?: string, message?: string) {
  const reason = decision === 'deny' ? message?.trim() : undefined;
  return { generation: a.generation, decision, ...(a.approval_kind === 'dispatch' && mode ? { mode } : {}), ...(reason ? { message: reason } : {}) };
}

/** POST /agent/interactions/{id}/answer: 1–8 answers for every question id. */
export function interactionAnswer(q: Question, answers: Record<string, string[]>) {
  for (const item of q.questions) {
    const a = answers[item.id];
    if (!a || a.length < 1 || a.length > 8) throw new RangeError(`question ${item.id} needs 1–8 answers`);
  }
  return { expected_version: q.revision, answers };
}

/** POST /agent/interactions/{id}/dismiss. */
export const interactionDismiss = (q: Question) => ({ expected_version: q.revision });

/** POST /agent/tasks/{cid}/(accept|reject). */
export const deliveryDecision = (d: Delivery) => ({ expected_revision: d.revision, generation: d.generation, delivery_id: d.id });

/** POST /agent/deliveries/{id}/(presented|viewed). */
export const deliveryReceipt = (d: Delivery) => ({ expected_revision: d.revision, generation: d.generation });

/** POST /agent/goals/{id}. */
export const goalState = (g: Goal, state: Goal['status']) => ({ expected_version: g.revision, state });

/** PUT /conversations/{id}: one or more of archived, pinned, title. */
export const conversationPatch = (c: Conversation, patch: { archived?: boolean; pinned?: boolean; title?: string }) => ({
  expected_version: c.revision,
  ...patch,
});

/** POST /conversations: a new conversation of that character, made her active one. */
export const conversationCreate = (character_id: string) => ({ character_id });

/** DELETE /conversations/{id} and POST …/activate (DELETE needs this JSON body too). */
export const conversationDelete = (c: Conversation) => ({ expected_version: c.revision });

/** POST /agent/runs/{id}/cancel. */
export const runCancel = (r: Pick<ActiveRun, 'generation'>) => ({ generation: r.generation });

/** POST /conversations/{id}/cancel. */
export const conversationCancel = (r: Pick<ActiveRun, 'run_id' | 'generation'>) => ({ run_id: r.run_id, generation: r.generation });

/** DELETE /character/state: the character whose state was read; agentd answers 409 character_changed after a switch. */
export function characterStateReset(s: Pick<CharacterState, 'character_id'>) {
  if (!s.character_id) throw new RangeError('no character to reset');
  return { character_id: s.character_id };
}

/** POST /memory/{id}/confirm without text; PATCH /memory/{id} with the corrected text. DELETE uses `?expected_version=`. */
export const factWrite = (f: Fact, text?: string) => ({ expected_version: f.version, ...(text !== undefined ? { text } : {}) });

/** PUT /observation/quiet: epoch seconds, after now and at most 1440 minutes ahead; null ends it. */
export const quiet = (untilMs: number | null) => ({ until: untilMs == null ? null : msToEpochSec(untilMs) });

/** PUT /observation/paused: whole minutes 0–1440; 0 resumes. */
export function paused(minutes: number) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new RangeError('minutes must be a whole number 0–1440');
  return { minutes };
}

/** PUT /observation/meeting. */
export const meeting = (on: boolean) => ({ on });

const RUNTIME_KEYS = [
  'backend',
  'runtime_source',
  'executable',
  'auth_source',
  'provider',
  'model',
  'max_budget_usd',
  'scope_id',
  'interactive_tools',
  'history_retention',
  'web_access',
  'routes',
  'acp_agent',
  'acp_launcher',
  'workspace_dir',
  'reply_language',
  'pi_tool_approval',
] as const satisfies ReadonlyArray<keyof WireRuntimeSettings>;

/** PUT /character/runtime merges a patch. Omitted settings stay server-owned, including picked executable paths. */
export function runtimeSettings(current: WireRuntimeSettings, patch: Partial<WireRuntimeSettings>): Partial<WireRuntimeSettings> {
  return Object.fromEntries(RUNTIME_KEYS.filter((k) => Object.hasOwn(patch, k) && patch[k] !== current[k]).map((k) => [k, patch[k]]));
}
