// @vitest-environment node
// Route contract: every method + path the web sends to agentd must be a routes.json route the bridge lets through.
// Known issues live in tests/route-contract.baseline.json, which may only shrink.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import type { MockModule } from '../../src/mock/types';
import { checkAll, compareBaseline, loadBaseline, loadRoutes, matchRoute, scanSource, scanStatic, surfacesFor, type Request } from '../../scripts/route-contract.ts';

const modules = import.meta.glob<MockModule>(['../../src/mock/*.ts', '!../../src/mock/index.ts', '!../../src/mock/types.ts'], { eager: true });
const mockRequests: Request[] = Object.keys(modules)
  .sort()
  .flatMap((k) => (modules[k]?.routes ?? []).map((r) => ({ method: r.method, path: r.path, module: k.replace('../../', '') })));

describe('matchRoute', () => {
  it('matches a literal path', () => {
    expect(matchRoute('GET', '/health')?.class).toBe('read');
  });

  it('matches a pattern with a full match only', () => {
    expect(matchRoute('GET', '/agent/jobs/0123456789abcdef0123456789abcdef')?.path).toBe('^/agent/jobs/([a-f0-9]{32})$');
    expect(matchRoute('GET', '/agent/jobs/0123456789abcdef0123456789abcdef/x')).toBeNull();
  });

  it('ignores the query', () => {
    expect(matchRoute('GET', '/memory?limit=5&q=a')?.path).toBe('/memory');
  });

  it('needs the same method', () => {
    expect(matchRoute('DELETE', '/health')).toBeNull();
    expect(matchRoute('POST', '/state')).toBeNull();
  });

  it('refuses paths with `;`', () => {
    expect(matchRoute('GET', '/health;x')).toBeNull();
    expect(matchRoute('GET', '/sessions/a;b/lines')).toBeNull();
    expect(matchRoute('GET', '/memory?q=a;b')).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute('GET', '/nope')).toBeNull();
  });
});

describe('route contract', () => {
  const scanned = scanStatic();
  const issues = checkAll([...mockRequests, ...scanned.requests]);
  const { added, gone } = compareBaseline(issues, loadBaseline());
  const show = (list: typeof issues) => list.map((i) => `${i.method} ${i.path} ${i.reason} ${i.module}`);

  it('scans src/ files', () => {
    expect(scanned.files).toBeGreaterThan(0);
  });

  it('sees calls made through the shared helpers in bridge/agentd.ts and data/tasksBase.ts', () => {
    const at = (module: string) => scanned.requests.filter((r) => r.module === module).map((r) => `${r.method} ${r.path}`);
    expect(at('src/shell/CmdPalette.tsx')).toEqual(expect.arrayContaining(['PUT /observation/quiet']));
    expect(at('src/data/runtime.ts')).toEqual(['GET /character/runtime', 'GET /character/runtime']);
    expect(at('src/data/tasksBase.ts')).toEqual(expect.arrayContaining(['GET /tasks', 'GET /agent/runs', 'GET /approvals', 'GET /agent/interactions']));
    expect(scanned.dynamic.filter((d) => d.module === 'src/bridge/agentd.ts')).toEqual([]);
  });

  it('skips a forwarded `path` only inside a registered wrapper, so an unregistered helper is not passed silently', () => {
    const src = "export async function get<T>(path: string) {\n  return request<T>('GET', path);\n}\nasync function helper(path: string) {\n  return get(path);\n}\n";
    const r = scanSource(src, 'src/data/tasksBase.ts');
    expect(r.requests).toEqual([]);
    expect(r.dynamic.map((d) => d.line)).toEqual([5]);
  });

  it('judges a request in a shared helper by the surfaces whose code imports that helper', () => {
    // A tree whose stack entry imports one of a shared module's two helpers.
    const root = mkdtempSync(join(tmpdir(), 'route-contract-'));
    try {
      mkdirSync(join(root, 'src/pages/p'), { recursive: true });
      writeFileSync(join(root, 'src/pages/p/api.ts'), "export function motion() {\n  return 1;\n}\nexport function model() {\n  return 2;\n}\n");
      writeFileSync(join(root, 'src/main.tsx'), "import { model, motion } from './pages/p/api';\nmodel();\nmotion();\n");
      writeFileSync(join(root, 'src/stack.tsx'), "import { motion } from './pages/p/api';\nmotion();\n");
      mkdirSync(join(root, 'src/pages/onboarding'));
      writeFileSync(join(root, 'src/pages/onboarding/Page.tsx'), '');
      const of = surfacesFor(root);
      expect(of({ method: 'GET', path: '/motion/settings', module: 'src/pages/p/api.ts', line: 2 })).toEqual(['main', 'stack']);
      expect(of({ method: 'GET', path: '/model/settings', module: 'src/pages/p/api.ts', line: 5 })).toEqual(['main']);
      const mainOnly = loadRoutes().map((r) => (r.path === '/motion/settings' ? { ...r, surfaces: ['main'] } : r));
      expect(show(checkAll([{ method: 'GET', path: '/motion/settings', module: 'src/pages/p/api.ts', line: 2 }], of, mainOnly))).toEqual([
        'GET /motion/settings surface:stack src/pages/p/api.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('judges the first-run guide\'s requests by the onboarding surface', () => {
    const noGuide = loadRoutes().map((r) => (r.method === 'GET' && r.path === '/model/settings' ? { ...r, surfaces: ['main'] } : r));
    const reads = scanned.requests.filter((r) => r.module === 'src/pages/settings/api.ts' && r.method === 'GET' && r.path === '/model/settings');
    expect(reads.length).toBeGreaterThan(0);
    expect(show(checkAll(reads, surfacesFor(), noGuide))).toContain('GET /model/settings surface:onboarding src/pages/settings/api.ts');
  });

  it('checks both branches of a ternary of literal paths, and leaves no call unchecked in src/', () => {
    const src = "import { get } from '../../bridge/agentd';\nexport const a = (c: boolean) => get(c ? '/memory?owner=x' : '/memory');\nexport const b = (p: string) => get(p);\n";
    const r = scanSource(src, 'src/pages/x/api.ts');
    expect(r.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /memory', 'GET /memory']);
    expect(r.dynamic.map((d) => d.line)).toEqual([3]);
    expect(scanned.dynamic).toEqual([]);
  });

  it('serves from the fake bridge\'s example endpoints only routes routes.json has', () => {
    const examples = exampleRoutes.map((r) => ({ method: r.method, path: r.path, module: 'src/bridge/fake/endpoints.ts' }));
    expect(show(checkAll(examples, () => [])).filter((i) => i.includes(' missing '))).toEqual([]);
  });

  it('has no issue outside the baseline', () => {
    expect(show(added), 'new route issues; fix the call or the mock (run check:routes)').toEqual([]);
  });

  it('lists only current issues in the baseline (it may only shrink)', () => {
    expect(show(gone), 'no longer issues; delete these from tests/route-contract.baseline.json').toEqual([]);
  });
});
