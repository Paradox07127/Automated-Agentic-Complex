// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Tokens } from '../../src/design/gen-tokens.ts';
import tokensJson from '../../src/design/tokens.json';

// Desktop overlays cast no shadow, and console rows are opaque.

const tokens = tokensJson as unknown as Tokens;
const themes = { dark: tokens.color.dark, light: { ...tokens.color.dark, ...tokens.color.light } };

function alpha(color: string): number {
  if (/^#[0-9a-f]{6}$/i.test(color)) return 1;
  const m = /^rgba?\(([^)]*)\)$/.exec(color);
  if (!m) throw new Error(`not a literal colour: ${color}`);
  const parts = m[1]!.split(',').map((s) => s.trim());
  return parts.length === 4 ? Number(parts[3]) : 1;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

describe('desktop overlays cast no shadow', () => {
  for (const [theme, vars] of Object.entries(themes)) {
    it(`${theme}: shadow-hud is none, and the words' shadow has the one name hud-text-shadow`, () => {
      expect(vars['shadow-hud'], `${theme} shadow-hud`).toBe('none');
      expect(vars['hud-text-shadow'], `${theme} hud-text-shadow`).toBeDefined();
      expect(vars['text-shadow-hud'], `${theme} text-shadow-hud`).toBeUndefined();
    });
  }
});

describe('desktop and stack CSS use only the HUD shadow', () => {
  const src = fileURLToPath(new URL('../../src/surfaces/', import.meta.url));
  const files = [...cssFiles(join(src, 'desktop')), ...cssFiles(join(src, 'stack'))];
  it('finds the CSS modules', () => {
    expect(files.length).toBeGreaterThan(10);
  });
  for (const file of files) {
    it(`${file.slice(src.length)} names no main-window shadow`, () => {
      expect(readFileSync(file, 'utf8')).not.toMatch(/--ef-shadow-(float|paper|list)\b/);
    });
  }
});

describe('HUD rows are opaque', () => {
  for (const [theme, vars] of Object.entries(themes)) {
    for (const key of ['hud-row', 'hud-row-head']) {
      it(`${theme}: ${key} has alpha 1`, () => {
        expect(alpha(vars[key]!)).toBe(1);
      });
    }
  }
});
