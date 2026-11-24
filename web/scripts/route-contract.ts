// Checks every method + path the web sends to agentd against protocol/ui-bridge/routes.json: the route must exist,
// its class must not be one the bridge refuses, and every surface that reaches the call must be in its `surfaces`.
// Sources: the mock routes (src/mock/*.ts) and literal paths at agentd.request call sites (and known wrappers) in src/.
// `node scripts/route-contract.ts` prints the issues and exits 1 on any issue not in tests/route-contract.baseline.json,
// and on any call whose method or path it cannot read.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RouteEntry {
  method: string;
  path: string;
  class: string;
  surfaces: string[];
}

/** A method + path pattern (`:name` segments) sent from `module` (a file path relative to web). */
export interface Request {
  method: string;
  path: string;
  module: string;
  line?: number;
}

export interface Issue {
  method: string;
  path: string;
  module: string;
  reason: string;
}

/** A call site whose method or path is not a literal. */
export interface DynamicCall {
  module: string;
  line: number;
  text: string;
}

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ROUTES_JSON = join(ROOT, '../protocol/ui-bridge/routes.json');
export const BASELINE_JSON = join(ROOT, 'tests/route-contract.baseline.json');

const DENIED = new Set(['native_only', 'host_only', 'hook_only', 'integration_only', 'stream']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SAMPLES = [
  '0123456789ab', '0123456789abcdef0123456789abcdef', '01234567-89ab-cdef-0123-456789abcdef',
  'job:0123456789ab', 'task:0123456789ab', 'delivery-0123456789abcdef0123456789abcdef',
  'own:0123456789ab', 'brief-0123456789abcdef0123456789abcdef',
  'obs-0123456789abcdef0123456789abcdef', 'work-0123456789abcdef0123456789abcdef',
  '1', 'x1', '2026-11-04',
];
const PARAM = /:[A-Za-z_]\w*/g;

export function loadRoutes(file: string = ROUTES_JSON): RouteEntry[] {
  return JSON.parse(readFileSync(file, 'utf8')) as RouteEntry[];
}

let defaultRoutes: RouteEntry[] | undefined;
let defaultSurfaces: ((r: Request) => string[]) | undefined;

/** The routes.json entry the bridge would match: literal paths first, then the `^` patterns in order (full match). */
export function matchRoute(method: string, path: string, routes: RouteEntry[] = (defaultRoutes ??= loadRoutes())): RouteEntry | null {
  if (path.includes(';')) return null;
  const p = path.split('?')[0] ?? '';
  const same = routes.filter((r) => r.method === method);
  return (
    same.find((r) => !r.path.startsWith('^') && r.path === p) ??
    same.find((r) => r.path.startsWith('^') && new RegExp(`^(?:${r.path})$`).test(p)) ??
    null
  );
}

/** First sample filling of the `:name` segments that hits a route for `method`; null when none does. */
export function concretize(pattern: string, method: string, routes: RouteEntry[] = (defaultRoutes ??= loadRoutes())): string | null {
  const parts = pattern.split(PARAM);
  const slots = parts.length - 1;
  for (let k = 0; k < SAMPLES.length ** slots; k += 1) {
    let path = parts[0] ?? '';
    for (let s = 0; s < slots; s += 1) {
      path += SAMPLES[Math.floor(k / SAMPLES.length ** (slots - 1 - s)) % SAMPLES.length];
      path += parts[s + 1];
    }
    if (matchRoute(method, path, routes)) return path;
  }
  return null;
}

const ENTRIES: Record<string, string> = { main: 'src/main.tsx', stack: 'src/stack.tsx', onboarding: 'src/pages/onboarding/Page.tsx' };
const DECL = /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Module paths relative to web, with `.ts`/`.tsx`/`index` resolution; null outside src or not a source. */
function resolveSpec(root: string, from: string, spec: string): string | null {
  const base = join(dirname(join(root, from)), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile()) return relative(root, c).split('\\').join('/');
  }
  return null;
}

/** import.meta.glob patterns: `*` within one path segment. */
function globSpec(root: string, from: string, pattern: string): string[] {
  const parts = relative(root, join(dirname(join(root, from)), pattern)).split('\\').join('/').split('/');
  let found = [''];
  for (const [k, part] of parts.entries()) {
    const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    found = found.flatMap((d) =>
      existsSync(join(root, d))
        ? readdirSync(join(root, d), { withFileTypes: true })
            .filter((e) => re.test(e.name) && (k === parts.length - 1 ? e.isFile() : e.isDirectory()))
            .map((e) => (d ? `${d}/${e.name}` : e.name))
        : [],
    );
  }
  return found;
}

/** A module's value imports: target module -> the names it takes, '*' for all. Type-only imports are left out. */
function importsOf(root: string, file: string): Map<string, Set<string>> {
  const src = readFileSync(join(root, file), 'utf8');
  const out = new Map<string, Set<string>>();
  const add = (spec: string, names: string[]) => {
    const target = resolveSpec(root, file, spec);
    if (target) out.set(target, new Set([...(out.get(target) ?? []), ...names]));
  };
  for (const m of src.matchAll(/(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*'(\.[^']+)'/g)) {
    if (m[2]) continue;
    const clause = m[3] ?? '';
    const braces = /\{([^}]*)\}/.exec(clause)?.[1];
    const names = braces === undefined ? ['*'] : braces.split(',').map((p) => p.trim()).filter((p) => p && !p.startsWith('type ')).map((p) => p.split(/\s+as\s+/)[0] ?? p);
    // `import Default, { a }` and `import * as ns` take more than the braces.
    if (/^\s*[\w$]+\s*(,|$)|\*/.test(clause)) names.push('*');
    if (names.length > 0) add(m[4] ?? '', names);
  }
  for (const m of src.matchAll(/(?:^|[;\n])\s*import\s*'(\.[^']+)'/g)) add(m[1] ?? '', ['*']);
  for (const m of src.matchAll(/\bimport\(\s*'(\.[^']+)'\s*\)/g)) add(m[1] ?? '', ['*']);
  for (const m of src.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*(\[[^\]]*\]|'[^']*')/g)) {
    for (const p of (m[1] ?? '').matchAll(/'([^']+)'/g)) {
      if (!(p[1] ?? '').startsWith('!')) for (const g of globSpec(root, file, p[1] ?? '')) out.set(g, new Set(['*']));
    }
  }
  return out;
}

/** The surfaces a request runs on: each entry whose import graph reaches the exported helper holding the call.
 * A call outside an exported declaration, or in one its own module also uses, goes with every surface reaching the module. */
export function surfacesFor(root: string = ROOT): (r: Request) => string[] {
  const graph = new Map<string, Map<string, Set<string>>>();
  const edges = (m: string) => graph.get(m) ?? graph.set(m, importsOf(root, m)).get(m)!;
  // surface -> module -> names its reached importers take
  const used = new Map<string, Map<string, Set<string>>>();
  for (const [surface, entry] of Object.entries(ENTRIES)) {
    const names = new Map<string, Set<string>>([[entry, new Set(['*'])]]);
    const todo = [entry];
    while (todo.length > 0) {
      for (const [target, taken] of edges(todo.pop()!)) {
        if (!names.has(target)) todo.push(target);
        names.set(target, new Set([...(names.get(target) ?? []), ...taken]));
      }
    }
    used.set(surface, names);
  }
  const holders = new Map<string, Array<{ line: number; name: string | null }>>();
  const holderOf = (r: Request) => {
    if (!holders.has(r.module)) {
      const src = readFileSync(join(root, r.module), 'utf8');
      const decls = [...src.matchAll(DECL)].map((m) => ({ line: src.slice(0, m.index).split('\n').length, name: m[1] ? (m[2] ?? null) : null, end: (m.index ?? 0) + m[0].length }));
      // An export the module also calls itself runs wherever the module does.
      holders.set(r.module, decls.map((d) => ({ line: d.line, name: d.name !== null && !new RegExp(`(?<![\\w$.])${d.name}\\b`).test(src.slice(0, d.end - d.name.length) + src.slice(d.end)) ? d.name : null })));
    }
    return [...holders.get(r.module)!].reverse().find((d) => d.line <= (r.line ?? 0))?.name ?? null;
  };
  return (r) => {
    if (r.module.startsWith('src/mock/')) return [r.module === 'src/mock/stack.ts' ? 'stack' : 'main'];
    const name = r.line === undefined ? null : holderOf(r);
    return [...used].filter(([, names]) => {
      const taken = names.get(r.module);
      return taken !== undefined && (name === null || taken.has('*') || taken.has(name));
    }).map(([surface]) => surface);
  };
}

const key = (i: Issue) => `${i.method} ${i.path} ${i.reason} ${i.module}`;

function sortIssues(list: Issue[]): Issue[] {
  const seen = new Map(list.map((i) => [key(i), i]));
  return [...seen.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function checkAll(requests: Request[], surfaces: (r: Request) => string[] = (defaultSurfaces ??= surfacesFor()), routes: RouteEntry[] = (defaultRoutes ??= loadRoutes())): Issue[] {
  const out: Issue[] = [];
  for (const r of requests) {
    const base = { method: r.method, path: r.path, module: r.module };
    const concrete = concretize(r.path, r.method, routes);
    const hit = concrete === null ? null : matchRoute(r.method, concrete, routes);
    if (!hit) out.push({ ...base, reason: 'missing' });
    else if (DENIED.has(hit.class)) out.push({ ...base, reason: `denied:${hit.class}` });
    else for (const s of surfaces(r)) if (!hit.surfaces.includes(s)) out.push({ ...base, reason: `surface:${s}` });
  }
  return sortIssues(out);
}

/** Issues not in the baseline, and baseline entries that are no longer issues. */
export function compareBaseline(current: Issue[], baseline: Issue[]): { added: Issue[]; gone: Issue[] } {
  const now = new Set(current.map(key));
  const before = new Set(baseline.map(key));
  return { added: current.filter((i) => !before.has(key(i))), gone: baseline.filter((i) => !now.has(key(i))) };
}

export function loadBaseline(file: string = BASELINE_JSON): Issue[] {
  return JSON.parse(readFileSync(file, 'utf8')) as Issue[];
}

// ---- static scan of src/ ----

interface Wrapper {
  file: string;
  name: string;
  /** Fixed method, or the index of the method argument. */
  method: string | number;
  path: number;
}

/** Functions that pass their method/path straight to agentd.request. */
export const WRAPPERS: Wrapper[] = [
  { file: 'src/bridge/agentd.ts', name: 'request', method: 0, path: 1 },
  { file: 'src/bridge/agentd.ts', name: 'call', method: 0, path: 1 },
  { file: 'src/bridge/agentd.ts', name: 'get', method: 'GET', path: 0 },
  { file: 'src/bridge/agentd.ts', name: 'post', method: 'POST', path: 0 },
  { file: 'src/bridge/agentd.ts', name: 'put', method: 'PUT', path: 0 },
  { file: 'src/bridge/agentd.ts', name: 'patch', method: 'PATCH', path: 0 },
  { file: 'src/bridge/agentd.ts', name: 'del', method: 'DELETE', path: 0 },
  { file: 'src/data/tasksBase.ts', name: 'get', method: 'GET', path: 0 },
  { file: 'src/data/tasksBase.ts', name: 'part', method: 'GET', path: 0 },
  { file: 'src/pages/memory/api.ts', name: 'call', method: 0, path: 1 },
  { file: 'src/pages/overview/nav.ts', name: 'call', method: 0, path: 1 },
  { file: 'src/pages/tasks/actions.ts', name: 'post', method: 'POST', path: 0 },
  { file: 'src/pages/chat/actions.ts', name: 'post', method: 'POST', path: 0 },
  { file: 'src/pages/chat/useChatData.ts', name: 'get', method: 'GET', path: 0 },
  { file: 'src/shell/CmdPalette.data.ts', name: 'read', method: 'GET', path: 0 },
];

/** `code`: comments blanked; `bare`: comments and string/template text blanked (template `${…}` code kept). */
function masks(src: string): { code: string; bare: string } {
  const code = src.split('');
  const bare = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (arr[k] !== '\n') arr[k] = ' ';
  };
  const quoted = (q: string) => {
    const start = i;
    i += 1;
    while (i < n && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
    blank(bare, start + 1, i);
    i += 1;
  };
  const template = () => {
    i += 1;
    let from = i;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        blank(bare, from, i);
        i += 2;
        scan(true);
        from = i;
        continue;
      }
      i += 1;
    }
    blank(bare, from, i);
    i += 1;
  };
  const scan = (inExpr: boolean) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {
        const s = i;
        while (i < n && src[i] !== '\n') i += 1;
        blank(code, s, i);
        blank(bare, s, i);
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        blank(code, i, stop);
        blank(bare, i, stop);
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        quoted(c);
        continue;
      }
      if (c === '`') {
        template();
        continue;
      }
      if (c === '{') depth += 1;
      if (c === '}') {
        if (inExpr && depth === 0) {
          i += 1;
          return;
        }
        depth -= 1;
      }
      i += 1;
    }
  };
  scan(false);
  return { code: code.join(''), bare: bare.join('') };
}

/** Top-level argument ranges of the call whose `(` is at `open`. */
function args(bare: string, open: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < bare.length; i += 1) {
    const c = bare[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (bare.slice(from, i).trim()) out.push([from, i]);
        return out;
      }
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  return out;
}

/** A string or template literal as a path pattern (`${…}` becomes a `:name` segment; a `${…}` that adds `?…` is dropped). */
function literal(code: string, bare: string): string | null {
  const c = code.trim();
  const b = bare.trim();
  const q = /^'([^'\\]*)'$/.exec(c) ?? /^"([^"\\]*)"$/.exec(c);
  if (q) return q[1] ?? '';
  if (!(b.startsWith('`') && b.endsWith('`'))) return null;
  const lead = code.length - code.trimStart().length;
  let out = '';
  let i = 1;
  while (i < b.length - 1) {
    if (b[i] === '`') return null;
    if (b[i] === '$' && b[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < b.length; j += 1) {
        if (b[j] === '{') depth += 1;
        if (b[j] === '}' && --depth === 0) break;
      }
      const expr = code.slice(lead + i + 2, lead + j);
      if (!/['"`]\?/.test(expr)) out += `:${/([A-Za-z_]\w*)\s*$/.exec(expr)?.[1] ?? 'x'}`;
      i = j + 1;
      continue;
    }
    out += c[i];
    i += 1;
  }
  return out;
}

/** `literal`, or both branches of `cond ? <literal> : <literal>`. */
function literals(code: string, bare: string): string[] | null {
  const one = literal(code, bare);
  if (one !== null) return [one];
  let depth = 0;
  let q = -1;
  let colon = -1;
  for (let i = 0; i < bare.length; i += 1) {
    const c = bare[i] ?? '';
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth > 0) continue;
    else if (c === '?' && q < 0 && bare[i + 1] !== '?' && bare[i + 1] !== '.' && bare[i - 1] !== '?') q = i;
    else if (c === ':' && q >= 0 && colon < 0) colon = i;
  }
  if (colon < 0) return null;
  const a = literal(code.slice(q + 1, colon), bare.slice(q + 1, colon));
  const b = literal(code.slice(colon + 1), bare.slice(colon + 1));
  return a === null || b === null ? null : [a, b];
}

function importedWrappers(code: string, file: string): Array<Wrapper & { local: string }> {
  const out: Array<Wrapper & { local: string }> = [];
  for (const m of code.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const spec = m[2] ?? '';
    if (!spec.startsWith('.')) continue;
    const target = join(dirname(file), spec).split('\\').join('/');
    for (const w of WRAPPERS) {
      if (w.file.replace(/\.tsx?$/, '') !== target) continue;
      for (const part of (m[1] ?? '').split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name === w.name) out.push({ ...w, local: alias ?? name });
      }
    }
  }
  return out;
}

/** Literal method + path of each agentd.request / wrapper call in one file (both paths of a ternary of literals);
 *  other calls go to `dynamic`. */
export function scanSource(src: string, file: string): { requests: Request[]; dynamic: DynamicCall[] } {
  const { code, bare } = masks(src);
  const requests: Request[] = [];
  const dynamic: DynamicCall[] = [];
  const lineOf = (at: number) => src.slice(0, at).split('\n').length;
  const own = WRAPPERS.filter((w) => w.file === file).map((w) => ({ ...w, local: w.name }));
  // Each own wrapper's definition, from its name to the next line that starts at column 0.
  const bodies = own.flatMap((w) =>
    [...bare.matchAll(new RegExp(`\\b(?:function|const)\\s+${w.name}\\b`, 'g'))].map((m) => {
      const end = bare.slice(m.index ?? 0).search(/\n\S/);
      return [m.index ?? 0, end < 0 ? bare.length : (m.index ?? 0) + end] as const;
    }),
  );
  const callees: Array<{ re: RegExp; method: string | number; path: number; wrapper: boolean }> = [
    { re: /agentd\s*\.\s*request\b/g, method: 0, path: 1, wrapper: false },
    ...[...own, ...importedWrappers(code, file)].map((w) => ({ re: new RegExp(`(?<![\\w$.])${w.local}\\b`, 'g'), method: w.method, path: w.path, wrapper: true })),
  ];
  for (const callee of callees) {
    for (const m of bare.matchAll(callee.re)) {
      const at = m.index ?? 0;
      if (callee.wrapper && /\bfunction\s*$/.test(bare.slice(0, at))) continue;
      let i = at + m[0].length;
      while (/\s/.test(bare[i] ?? '')) i += 1;
      if (bare[i] === '<') {
        let depth = 0;
        for (; i < bare.length; i += 1) {
          if (bare[i] === '<') depth += 1;
          if (bare[i] === '>' && bare[i - 1] !== '=' && --depth === 0) break;
        }
        i += 1;
        while (/\s/.test(bare[i] ?? '')) i += 1;
      }
      if (bare[i] !== '(') continue;
      const list = args(bare, i);
      const arg = (k: number) => {
        const r = list[k];
        return r ? { code: code.slice(r[0], r[1]), bare: bare.slice(r[0], r[1]) } : null;
      };
      const pathArg = arg(callee.path);
      // The wrappers' own forwarding call; their callers are scanned instead.
      if (pathArg?.code.trim() === 'path' && bodies.some(([a, b]) => at > a && at < b)) continue;
      const methodArg = typeof callee.method === 'number' ? arg(callee.method) : null;
      const method = typeof callee.method === 'string' ? callee.method : methodArg ? literal(methodArg.code, methodArg.bare) : null;
      const paths = pathArg ? literals(pathArg.code, pathArg.bare) : null;
      const line = lineOf(at);
      if (method === null || !METHODS.has(method) || paths === null) {
        dynamic.push({ module: file, line, text: code.slice(at, (list.at(-1)?.[1] ?? i) + 1).replace(/\s+/g, ' ').slice(0, 120) });
        continue;
      }
      // A `;` anywhere (query included) is refused by the bridge, so keep it in the path to be judged.
      for (const path of paths) requests.push({ method, path: path.includes(';') ? path : (path.split('?')[0] ?? ''), module: file, line });
    }
  }
  return { requests, dynamic };
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Scans src/ except src/mock and *.demo files. */
export function scanStatic(root: string = ROOT): { files: number; requests: Request[]; dynamic: DynamicCall[] } {
  const requests: Request[] = [];
  const dynamic: DynamicCall[] = [];
  let files = 0;
  for (const path of walk(join(root, 'src'))) {
    const file = relative(root, path).split('\\').join('/');
    if (!/\.tsx?$/.test(file) || /\.demo\./.test(file) || file.startsWith('src/mock/')) continue;
    const r = scanSource(readFileSync(path, 'utf8'), file);
    files += 1;
    requests.push(...r.requests);
    dynamic.push(...r.dynamic);
  }
  return { files, requests, dynamic };
}

/** `src/mock/*.ts` modules that export `routes`, in the order src/mock/index.ts collects them. */
export function mockFiles(root: string = ROOT): string[] {
  return readdirSync(join(root, 'src/mock'))
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts')
    .sort()
    .map((f) => `src/mock/${f}`);
}

async function loadMockRequests(): Promise<Request[]> {
  const { createServer } = await import('vite');
  const server = await createServer({ root: ROOT, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null } });
  try {
    const out: Request[] = [];
    for (const file of mockFiles()) {
      const mod = (await server.ssrLoadModule(`/${file}`)) as { routes?: Array<{ method: string; path: string }> };
      for (const r of mod.routes ?? []) out.push({ method: r.method, path: r.path, module: file });
    }
    return out;
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  const mocks = await loadMockRequests();
  const { files, requests, dynamic } = scanStatic();
  const issues = checkAll([...mocks, ...requests]);
  const { added, gone } = compareBaseline(issues, loadBaseline());
  const lines = new Map<string, number[]>();
  for (const r of requests) lines.set(`${r.method} ${r.path} ${r.module}`, [...(lines.get(`${r.method} ${r.path} ${r.module}`) ?? []), r.line ?? 0]);
  const fresh = new Set(added.map(key));

  const byReason = new Map<string, Issue[]>();
  for (const i of issues) byReason.set(i.reason, [...(byReason.get(i.reason) ?? []), i]);
  console.log(`ROUTES: ${issues.length} issue(s), ${added.length} not in baseline, ${gone.length} baseline entr${gone.length === 1 ? 'y' : 'ies'} fixed`);
  for (const [reason, list] of [...byReason].sort()) console.log(`  ${reason.padEnd(18)} ${list.length}`);
  for (const [reason, list] of [...byReason].sort()) {
    console.log(`\n${reason}`);
    for (const i of list) {
      const at = lines.get(`${i.method} ${i.path} ${i.module}`);
      console.log(`  ${fresh.has(key(i)) ? '+' : ' '} ${i.method.padEnd(6)} ${i.path.padEnd(44)} ${i.module}${at ? `:${at.join(',')}` : ''}`);
    }
  }
  console.log(`\nstatic: ${files} files scanned, ${requests.length} calls, ${dynamic.length} dynamic`);
  console.log(`dynamic: ${dynamic.length} call(s) without a literal method/path`);
  for (const d of dynamic) console.log(`  ${d.module}:${d.line}  ${d.text}`);
  if (gone.length > 0) {
    console.log('\nNo longer issues; delete from tests/route-contract.baseline.json:');
    for (const i of gone) console.log(`  ${i.method} ${i.path} ${i.reason} ${i.module}`);
  }
  if (added.length > 0) console.error(`\nROUTES FAIL: ${added.length} issue(s) not in the baseline (marked +)`);
  if (dynamic.length > 0) console.error(`\nROUTES FAIL: ${dynamic.length} call(s) whose method or path is not a literal; write it as one`);
  if (added.length > 0 || dynamic.length > 0) process.exit(1);
}

if (import.meta.main) await main();
