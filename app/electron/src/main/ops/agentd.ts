// `agentd.*`: requests to agentd on the page's behalf and the `/feed` connection's state.
import { agentdError, checkRequest, HandleRequired, rejected, RouteTable, swapHandles } from '../../common/routes.ts';
import type { Interaction } from '../../common/stack-cards.ts';
import { type Approval, answerQuestion, approvalQuestion } from '../../common/stack-source.ts';
import { markNow } from '../../common/turn-marks.ts';
import { type AgentdClient, NotSentError } from '../agentd/client.ts';
import type { Ops, OpsContext } from './context.ts';

const DECISION = /^\/approvals\/([^/]+)\/decision$/u;
const ANSWER = /^\/agent\/interactions\/([^/]+)\/answer$/u;

/** A decision the page posts itself meets StackDecisions' rules against agentd's live approval or interaction of that id,
 *  with no click to stand for the gesture: what needs one asks natively. The refusal to reply with, or null to send it. */
async function decisionGate(agentd: AgentdClient, confirm: (text: string) => Promise<boolean>, method: string, route: string,
  body: Record<string, unknown> | undefined): Promise<ReturnType<typeof rejected> | null> {
  const decision = method === 'POST' ? DECISION.exec(route) : null, answer = method === 'POST' ? ANSWER.exec(route) : null;
  const id = (decision ?? answer)?.[1];
  if (id === undefined) return null;
  const [list, key] = decision ? ['/approvals', 'approvals'] : ['/agent/interactions', 'requests'];
  let status: number, data: Buffer;
  try {
    ({ status, body: data } = await agentd.request('GET', list));
  } catch {
    return rejected('offline', 'agentd is unreachable');
  }
  let json: unknown = null;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch { /* not JSON: null */ }
  const rows = status >= 200 && status < 300 ? (json as Record<string, unknown> | null)?.[key] : undefined;
  if (!Array.isArray(rows)) return rejected(agentdError(status, json).code, `GET ${list}`);
  const row: unknown = rows.find((r) => (r as Record<string, unknown> | null)?.request_id === id);
  if (row === undefined) return rejected('stale', `no live ${decision ? 'approval' : 'interaction'} ${id}`);
  const answers = body?.answers;
  const question = decision ? approvalQuestion(row as Approval, body?.decision, body?.mode)
    : answerQuestion(row as Interaction, typeof answers === 'object' && answers !== null && !Array.isArray(answers) ? answers as Record<string, unknown> : {});
  return question !== null && !(await confirm(question)) ? rejected('declined', `${method} ${route}`) : null;
}

export function agentdOps(ctx: OpsContext): Ops {
  const table = new RouteTable(ctx.routes);
  return {
    /** protocol.ts `AgentdResponse`; a request the bridge does not send has status 0 and an error. */
    'agentd.request': async ([method, path, body], page) => {
      const checked = checkRequest(table, ctx.surface, method, path, body);
      if (!checked.ok) return checked.reply;
      const route = checked.path.split('?')[0]!;
      let swapped: ReturnType<typeof swapHandles>;
      try {
        swapped = swapHandles(checked.method, checked.route.path, checked.body, page.picked, ctx.dropped ?? undefined);
      } catch (e) {
        return rejected('handle_required', e instanceof HandleRequired ? e.field : '');
      }
      if (checked.route.class === 'confirm_native' && !(await ctx.confirm(`${checked.method} ${route}`))) {
        return rejected('declined', `${checked.method} ${route}`);
      }
      const refused = ctx.agentd && await decisionGate(ctx.agentd, ctx.confirm, checked.method, route, checked.body);
      if (refused) return refused;
      // Out of `picked` while the request is out, so no other request sends them too; one sent meanwhile went already.
      if ([...swapped.used].some((handle) => !page.picked.has(handle))) return rejected('handle_required', '');
      const taken = [...swapped.used].map((handle) => [handle, page.picked.get(handle)!] as const);
      for (const [handle] of taken) page.picked.delete(handle);
      if (!ctx.agentd) {
        for (const [, entry] of taken) entry.discard?.();
        return rejected('offline', 'agentd is unreachable');
      }
      const message = checked.method === 'POST' && route.startsWith('/conversations/') && route.endsWith('/messages');
      const submittedAt = markNow();
      const generation = page.generation;
      let status: number, data: Buffer;
      try {
        ({ status, body: data } = await ctx.agentd.request(checked.method, checked.path, swapped.body));
      } catch (e) {
        // Never sent, the page may send them again unless its document ended meanwhile; otherwise agentd may have taken them.
        for (const [handle, entry] of taken) {
          if (e instanceof NotSentError && page.generation === generation) page.picked.set(handle, entry);
          else entry.discard?.();
        }
        return rejected('offline', 'agentd is unreachable');
      }
      if (status < 200 || status >= 300) for (const [, entry] of taken) entry.discard?.();
      let json: unknown = null;
      try {
        json = JSON.parse(data.toString('utf8'));
      } catch { /* not JSON: null */ }
      if (message) {
        ctx.turnMarks?.acceptedBody(status, typeof json === 'object' && json !== null && !Array.isArray(json) ? json as Record<string, unknown> : null,
          submittedAt);
      }
      const reply: Record<string, unknown> = { status, body: json };
      if (status < 200 || status >= 300) reply.error = agentdError(status, json);
      return reply;
    },
    'agentd.connection': () => ctx.store?.connection ?? 'offline',
  };
}
