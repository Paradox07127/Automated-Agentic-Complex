// `files.*`: native file pickers whose choice the page holds only as a handle, and
// saving an agentd export where the user chooses.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { BridgeFailure } from '../../common/bridge.ts';
import { agentdError, isExportPath } from '../../common/routes.ts';
import type { Ops, OpsContext } from './context.ts';

const FILE_PURPOSES = ['runtime_executable', 'scope_file'];
const FOLDER_PURPOSES = ['scope_root', 'scope_output', 'session_cwd'];

export function filesOps(ctx: OpsContext): Ops {
  const pick = (file: boolean): Ops[string] => async ([options], page) => {
    const purpose = typeof options === 'object' && options !== null ? (options as Record<string, unknown>).purpose : undefined;
    if (typeof purpose !== 'string' || !(file ? FILE_PURPOSES : FOLDER_PURPOSES).includes(purpose)) {
      throw new BridgeFailure('invalid_args', 'purpose');
    }
    const generation = page.generation;
    const path = file ? await ctx.dialog.pickFile(purpose) : await ctx.dialog.pickFolder(purpose);
    if (path === null || generation !== page.generation) return null;
    const handle = randomUUID().toUpperCase();
    page.picked.set(handle, { purpose, path });
    return { handle, displayName: basename(path) };
  };
  return {
    'files.pickFile': pick(true),
    'files.pickFolder': pick(false),
    /** GETs an export agentd serves, then asks where to save it; false when the user declined or cancelled. */
    'files.saveAgentdExport': async ([options], page) => {
      const o = typeof options === 'object' && options !== null ? options as Record<string, unknown> : {};
      if (typeof o.path !== 'string' || !isExportPath(o.path)) throw new BridgeFailure('invalid_args', 'export path');
      const generation = page.generation;
      let name = basename(typeof o.suggestedName === 'string' ? o.suggestedName : '');
      if (name === '' || name === '.' || name === '..') name = 'export';
      if (!name.toLowerCase().endsWith('.json')) name += '.json';
      if (o.path.endsWith('?with_text=1') && !(await ctx.confirm('带内容导出这一轮？导出的文件里有原话和台词全文，只存在你选的位置'))) {
        return false;
      }
      if (!ctx.agentd) throw new BridgeFailure('offline', 'agentd is unreachable');
      let reply: { status: number; body: Buffer };
      try {
        reply = await ctx.agentd.request('GET', o.path);
      } catch {
        throw new BridgeFailure('offline', 'agentd is unreachable');
      }
      if (reply.status < 200 || reply.status >= 300) {
        let body: unknown = null;
        try {
          body = JSON.parse(reply.body.toString('utf8'));
        } catch { /* agentdError takes null */ }
        const e = agentdError(reply.status, body);
        throw new BridgeFailure('failed', e.detail ?? e.code);
      }
      if (generation !== page.generation) return false;
      return ctx.dialog.saveFile(reply.body, name);
    },
  };
}
