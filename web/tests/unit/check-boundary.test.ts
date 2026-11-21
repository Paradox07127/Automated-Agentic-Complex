import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../scripts/check-boundary.mjs';

/** Runs the check on a web root built from `files` (path from the root → text). */
function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'check-boundary-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return run(join(root, 'src'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const mock = { 'src/mock/fixtures/clock.ts': 'export const NOW = 1;\n' };

describe('check-boundary', () => {
  it('finds no production import of demo code in src outside the allowlist', () => {
    expect(run(join(process.cwd(), 'src'))).toEqual({ violations: [], stale: [] });
  });

  it('flags a static import into the boundary', () => {
    expect(check({ ...mock, 'src/pages/a/api.ts': "import { NOW } from '../../mock/fixtures/clock';\n" }).violations).toEqual([
      'src/pages/a/api.ts:1  -> ../../mock/fixtures/clock',
    ]);
  });

  it('flags a type-only import', () => {
    expect(check({ ...mock, 'src/pages/a/api.ts': "\nimport type { X } from '../../mock/fixtures/clock';\n" }).violations).toEqual([
      'src/pages/a/api.ts:2  -> ../../mock/fixtures/clock',
    ]);
  });

  it('flags a dynamic import and a glob into the boundary', () => {
    const r = check({
      ...mock,
      'src/pages/a/demos.ts': 'export const demos = [];\n',
      'src/pages/a/load.ts': "const m = await import('../../mock/fixtures/clock');\nimport.meta.glob('../*/demos.ts');\n",
    });
    expect(r.violations).toEqual(['src/pages/a/load.ts:1  -> ../../mock/fixtures/clock', 'src/pages/a/load.ts:2  -> ../*/demos.ts']);
  });

  it('lets demo code import demo code, and reports an allowlisted file that no longer violates', () => {
    const r = check({
      ...mock,
      'src/mock/x.ts': "import { NOW } from './fixtures/clock';\n",
      'src/pages/a/api.ts': 'export {};\n',
      'scripts/check-boundary.allow': '# O10x\nsrc/pages/a/api.ts\n',
    });
    expect(r).toEqual({ violations: [], stale: ['src/pages/a/api.ts'] });
  });
});
