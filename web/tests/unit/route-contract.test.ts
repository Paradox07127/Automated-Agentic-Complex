// @vitest-environment node
// Route contract: every method + path the web sends to agentd must be a routes.json route the bridge lets through.
// Known issues live in tests/route-contract.baseline.json, which may only shrink.
import { describe, expect, it } from 'vitest';
import type { MockModule } from '../../src/mock/types';
import { checkAll, compareBaseline, loadBaseline, loadRoutes, matchRoute, scanStatic, type Request } from '../../scripts/route-contract.ts';

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
    expect(at('src/data/tasksBase.ts')).toEqual(expect.arrayContaining(['GET /tasks', 'GET /agent/runs']));
    expect(scanned.dynamic.filter((d) => d.module === 'src/bridge/agentd.ts')).toEqual([]);
  });

  it('judges a request in a shared helper by the surfaces whose code imports that helper', () => {
    const mainOnly = loadRoutes().map((r) => (r.path === '/motion/settings' ? { ...r, surfaces: ['main'] } : r));
    expect(show(checkAll(scanned.requests, undefined, mainOnly))).toEqual(
      expect.arrayContaining(['GET /motion/settings surface:stack src/pages/settings/api.ts', 'PUT /motion/settings surface:stack src/pages/settings/api.ts']),
    );
    // api.ts is reached from stack, but stack imports none of the model helpers.
    expect(show(issues).filter((i) => i.includes('/model/settings'))).toEqual([]);
  });

  it('has no issue outside the baseline', () => {
    expect(show(added), 'new route issues; fix the call or the mock (run check:routes)').toEqual([]);
  });

  it('lists only current issues in the baseline (it may only shrink)', () => {
    expect(show(gone), 'no longer issues; delete these from tests/route-contract.baseline.json').toEqual([]);
  });
});
