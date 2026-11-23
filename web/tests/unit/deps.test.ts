import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

// Packages used without a TS import.
const whitelist: Record<string, string> = {};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx|mts|mjs)$/.test(e.name) ? [p] : [];
  });

const imported = new Set<string>();
for (const file of sources(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"./][^'"]*)['"]/g)) {
    const spec = m[1]!;
    const parts = spec.split('/');
    imported.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
  }
}

describe('package.json dependencies', () => {
  it('every dependency is imported from src or whitelisted', () => {
    const unused = Object.keys(pkg.dependencies).filter((d) => !imported.has(d) && !(d in whitelist));
    expect(unused).toEqual([]);
  });

  it('every whitelist entry is still a dependency', () => {
    expect(Object.keys(whitelist).filter((d) => !(d in pkg.dependencies))).toEqual([]);
  });
});
