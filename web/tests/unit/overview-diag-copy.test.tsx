// 总览 / 诊断: copy and components of both pages (page cases moved to overview-page and diag-page).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = `${resolve(dirname(fileURLToPath(import.meta.url)), '../..')}/`;

describe('copy and components', () => {
  const dirs = ['src/pages/overview', 'src/pages/diag'];

  it('check:copy has no hit in the overview and diag pages', () => {
    let out = '';
    try {
      out = execFileSync('node', ['scripts/check-copy.mjs'], { cwd: root, encoding: 'utf8' });
    } catch (e) {
      const r = e as { stdout?: string; stderr?: string };
      out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    }
    expect(out.split('\n').filter((l) => dirs.some((d) => l.includes(d)))).toEqual([]);
  });

  it('the pages import no deprecated component and no Modal', () => {
    const banned = /\b(Eyebrow|Emblem|PaperCard|KvTag|FoldRow|NeedBox|Modal)\b/;
    for (const d of dirs) {
      for (const f of readdirSync(`${root}${d}`)) {
        if (!f.endsWith('.tsx')) continue;
        const imports = readFileSync(`${root}${d}/${f}`, 'utf8').match(/^import[\s\S]*?from '[^']+';/gm) ?? [];
        expect(imports.filter((l) => banned.test(l)), `${d}/${f}`).toEqual([]);
      }
    }
  });
});
