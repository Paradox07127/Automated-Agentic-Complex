// `agentd.request`'s checks before it sends: method, path shape, the route's class and
// surfaces in protocol/ui-bridge/routes.json, the body, and picked file handles in place of paths.
import { MAX_SCOPE_FILES } from './adoption.ts';
import type { Surface } from './bridge.ts';

/** One entry of protocol/ui-bridge/routes.json; a `path` starting with `^` is a pattern. */
export interface Route { method: string; path: string; class: string; surfaces: string[] }

export const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A route starts with `/`; no `//`, `..`, `#`, `;` or control character; at most 2048 UTF-8 bytes. */
export function isWellFormed(path: string): boolean {
  return path.startsWith('/') && new TextEncoder().encode(path).length <= 2048 && !path.includes('//') && !path.includes('..')
    && !path.includes('#') && !path.includes(';') && !CONTROL.test(path);
}

/** The agentd client's `new URL(baseUrl + path)` keeps `path` as it is: no `%2e` or `.` segment, `\`, or character it
 *  would percent-encode, so the path checked is the path sent. */
function sentAsIs(path: string): boolean {
  let url: URL;
  try {
    url = new URL(`http://h${path}`);
  } catch {
    return false;
  }
  return url.pathname + url.search === path;
}

/** `/history/export`, `/memory/export`, or one trace turn with or without its text. */
export function isExportPath(path: string): boolean {
  if (path === '/history/export' || path === '/memory/export') return true;
  return isWellFormed(path) && sentAsIs(path) && /^\/trace\/turns\/[^/?]{1,64}(\?with_text=1)?$/u.test(path);
}

/** Absolute, at most 4096 UTF-8 bytes, without control characters or `..` components. */
export function isLocalPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && new TextEncoder().encode(path).length <= 4096 && !CONTROL.test(path)
    && !path.split('/').includes('..');
}

/** Literal paths first, then the patterns in file order, matched against the whole path. */
export class RouteTable {
  private readonly literal = new Map<string, Route>();
  private readonly patterns: { route: Route; regex: RegExp | null }[] = [];

  constructor(routes: Route[]) {
    for (const route of routes) {
      if (route.path.startsWith('^')) {
        let regex: RegExp | null = null;
        try {
          regex = new RegExp(route.path, 'u');
        } catch { /* never matches */ }
        this.patterns.push({ route, regex });
      } else if (!this.literal.has(`${route.method} ${route.path}`)) {
        this.literal.set(`${route.method} ${route.path}`, route);
      }
    }
  }

  match(method: string, path: string): Route | undefined {
    const literal = this.literal.get(`${method} ${path}`);
    if (literal) return literal;
    return this.patterns.find(({ route, regex }) => {
      if (route.method !== method || !regex) return false;
      const found = regex.exec(path);
      return found !== null && found.index === 0 && found[0].length === path.length;
    })?.route;
  }
}

/** protocol.ts `AgentdResponse`'s `error` of a non-2xx reply: agentd's `error` string, else `http_<status>`. */
export function agentdError(status: number, body: unknown): { code: string; detail?: string } {
  const o = isObject(body) ? body : {};
  const error: { code: string; detail?: string } = { code: typeof o.error === 'string' ? o.error : `http_${status}` };
  if (typeof o.detail === 'string') error.detail = o.detail;
  return error;
}

/** A refusal before sending: status 0, no body. */
export function rejected(code: string, detail: string): { status: 0; body: null; error: { code: string; detail: string } } {
  return { status: 0, body: null, error: { code, detail } };
}

export type Checked =
  | { ok: true; method: string; path: string; route: Route; body: Record<string, unknown> | undefined }
  | { ok: false; reply: ReturnType<typeof rejected> };

/** Every check before handles are swapped and `confirm_native` asked. */
export function checkRequest(table: RouteTable, surface: Surface, method: unknown, path: unknown, body: unknown): Checked {
  const no = (code: string, detail: string): Checked => ({ ok: false, reply: rejected(code, detail) });
  if (typeof method !== 'string' || !METHODS.has(method)) return no('invalid_method', method == null ? 'nil' : String(method));
  if (typeof path !== 'string' || !isWellFormed(path)) return no('invalid_path', 'path shape');
  if (!sentAsIs(path)) return no('invalid_path', 'path changes when sent');
  const routePath = path.split('?')[0]!;
  const route = table.match(method, routePath);
  if (!route) return no('unclassified_route', `${method} ${routePath}`);
  if (!['read', 'write', 'confirm_native'].includes(route.class)) return no('route_class', route.class);
  if (!route.surfaces.includes(surface)) return no('surface_not_allowed', surface);
  if (body != null && !isObject(body)) return no('invalid_body', 'body must be a JSON object');
  if (method === 'POST' && routePath === '/agent/scopes' && body != null && Array.isArray(body.files) && body.files.length > MAX_SCOPE_FILES) {
    return no('invalid_files', 'at most 16 files per scope');
  }
  return { ok: true, method, path, route, body: body == null ? undefined : body };
}

class HandleRequired extends Error {
  readonly field: string;
  constructor(field: string) {
    super(field);
    this.field = field;
  }
}

/** `body` with each picked handle in a path field, and each dropped file's handle in `POST /agent/scopes` `files`, swapped
 *  for its path, and the picked handles used; throws `HandleRequired` for a field holding anything else than an unused
 *  handle of its purpose (protocol/ui-bridge/CONTRACT.md step 7). */
export function swapHandles(method: string, route: string, json: Record<string, unknown> | undefined,
  picked: ReadonlyMap<string, { purpose: string; path: string }>, dropped: ReadonlyMap<string, string> = new Map()):
  { body: Record<string, unknown> | undefined; used: Set<string> } {
  const used = new Set<string>();
  if (json === undefined) return { body: undefined, used };
  const body = { ...json };
  const path = (value: unknown, purpose: string, field: string): string => {
    const handle = isObject(value) ? value.handle : undefined;
    const entry = typeof handle === 'string' ? picked.get(handle) : undefined;
    if (typeof handle !== 'string' || !entry || entry.purpose !== purpose || used.has(handle)) throw new HandleRequired(field);
    used.add(handle);
    return entry.path;
  };
  const key = `${method} ${route}`;
  if (key === 'PUT /character/runtime') {
    if (body.executable != null) body.executable = path(body.executable, 'runtime_executable', 'executable');
    if (body.workspace_dir != null) body.workspace_dir = path(body.workspace_dir, 'session_cwd', 'workspace_dir');
  } else if (key === 'POST /agent/scopes') {
    if ('roots' in body) {
      if (!Array.isArray(body.roots)) throw new HandleRequired('roots');
      body.roots = body.roots.map((r) => path(r, 'scope_root', 'roots'));
    }
    if (body.output_root != null) body.output_root = path(body.output_root, 'scope_output', 'output_root');
    // A dropped file's handle stays good for every scope its card makes; a picked one is used once.
    if (Array.isArray(body.files)) {
      body.files = body.files.map((f) => {
        const handle = isObject(f) ? f.handle : undefined;
        return (typeof handle === 'string' ? dropped.get(handle) : undefined) ?? path(f, 'scope_file', 'files');
      });
    }
  } else if (key === 'POST /sessions') {
    if (body.cwd != null) body.cwd = path(body.cwd, 'session_cwd', 'cwd');
  } else if (key === 'POST /say') {
    if ('cwd' in body) throw new HandleRequired('cwd');
  }
  return { body, used };
}

export { HandleRequired };
