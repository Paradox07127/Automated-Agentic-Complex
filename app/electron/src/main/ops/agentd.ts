// `agentd.*`: requests to agentd on the page's behalf and the `/feed` connection's state.
import { agentdError, checkRequest, HandleRequired, rejected, RouteTable, swapHandles } from '../../common/routes.ts';
import { markNow } from '../../common/turn-marks.ts';
import type { Ops, OpsContext } from './context.ts';

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
      const discards = [...swapped.used].map(handle => page.picked.get(handle)?.discard);
      for (const handle of swapped.used) page.picked.delete(handle);
      if (!ctx.agentd) {
        for (const discard of discards) discard?.();
        return rejected('offline', 'agentd is unreachable');
      }
      const message = checked.method === 'POST' && route.startsWith('/conversations/') && route.endsWith('/messages');
      const submittedAt = markNow();
      let status: number, data: Buffer;
      try {
        ({ status, body: data } = await ctx.agentd.request(checked.method, checked.path, swapped.body));
      } catch {
        return rejected('offline', 'agentd is unreachable');
      }
      if (status < 200 || status >= 300) for (const discard of discards) discard?.();
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
