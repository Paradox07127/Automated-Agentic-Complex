// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Tokens } from '../../src/design/gen-tokens.ts';
import tokensJson from '../../src/design/tokens.json';

const tokens = tokensJson as unknown as Tokens;

type Theme = 'dark' | 'light';

function palette(theme: Theme): Record<string, string> {
  return theme === 'dark' ? { ...tokens.color.dark } : { ...tokens.color.dark, ...tokens.color.light };
}

function resolve(theme: Theme, name: string): string {
  const p = palette(theme);
  let v = p[name];
  for (let i = 0; v?.startsWith('var(--ef-') && i < 5; i++) v = p[v.slice(9, -1)];
  if (!v || !/^#[0-9A-F]{6}$/i.test(v)) throw new Error(`${theme} ${name} is not an opaque hex color: ${v}`);
  return v;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const levels = ['canvas', 'base', 'raised', 'overlay'] as const;

describe('four surface levels', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const level of levels) {
      for (const fg of [`${level}-fg`, 'text-1', 'text-2']) {
        it(`${theme}: ${fg} on ${level} >= 4.5`, () => {
          expect(contrast(resolve(theme, fg), resolve(theme, level))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it('keeps the earlier surface names beside the four levels', () => {
    expect(tokens.color.dark).toMatchObject({ 'bg-canvas': '#161616', 'bg-base': '#191919', slab: 'rgba(255,255,255,.14)', plate: '#262626', row: '#232323', band: '#141414' });
    expect(tokens.color.light).toMatchObject({ 'bg-canvas': '#ECECE9', 'bg-base': '#F4F4F2', slab: 'rgba(0,0,0,.04)' });
    for (const theme of ['dark', 'light'] as const) {
      expect(resolve(theme, 'base')).toBe(resolve(theme, 'bg-base'));
      expect(resolve(theme, 'canvas')).toBe(resolve(theme, 'bg-canvas'));
    }
  });
});

describe('type, space and radius scales', () => {
  const size = tokens.type.size;
  const lh = tokens.type.lineHeight;
  const role = (tokens.type as unknown as { role: Record<string, string> }).role;

  it.each([
    ['h1', '18px', '26px', 'semibold'],
    ['h2', '15px', '22px', 'semibold'],
    ['h3', '13px', '20px', 'semibold'],
    ['text', '14px', '22px', 'regular'],
    ['row', '14px', '20px', 'medium'],
    ['table', '13px', '20px', 'regular'],
    ['meta', '12px', '18px', 'regular'],
    ['num', '13px', '16px', 'regular'],
    ['mono', '12px', '18px', 'regular'],
  ])('%s is %s/%s %s', (name, fs, line, weight) => {
    expect(size[`fs-${name}`]).toBe(fs);
    expect(lh[`lh-${name}`]).toBe(line);
    const face = name === 'mono' || name === 'num' ? name : 'sans';
    expect(role[`t-${name}`]).toBe(`var(--ef-fw-${weight}) var(--ef-fs-${name}) / var(--ef-lh-${name}) var(--ef-font-${face})`);
  });

  it('has a big-number size in the 24–28 range on the wide face', () => {
    expect(size['fs-big']).toBe('28px');
    expect(role['t-big']).toContain('var(--ef-font-wide)');
  });

  it('keeps every Chinese-capable size at 12px or more, numbers at the table size and 11px for key caps only', () => {
    for (const name of ['h1', 'h2', 'h3', 'text', 'row', 'table', 'meta', 'mono']) expect(parseInt(size[`fs-${name}`] ?? '0')).toBeGreaterThanOrEqual(12);
    expect(size['fs-num']).toBe(size['fs-table']);
    expect(size['fs-keycap']).toBe('11px');
  });

  it('spaces on 4 / 8 / 12 / 16 / 24 / 32 / 48', () => {
    expect(tokens.space).toMatchObject({ 'space-page': 'var(--ef-sp-24)', 'space-section': 'var(--ef-sp-32)', 'space-block': 'var(--ef-sp-16)', 'space-inline': 'var(--ef-sp-12)', 'space-control': 'var(--ef-sp-8)' });
    for (const n of [4, 8, 12, 16, 24, 32, 48]) expect(tokens.space[`sp-${n}`]).toBe(`${n}px`);
  });

  it('has a 56 px header and a 24 px section gap, 48 and 18 under 700 px high', () => {
    expect(tokens.size['page-header']).toBe('56px');
    expect(tokens.size['sec-gap']).toBe('24px');
    expect(tokens.compactHeight).toEqual({ 'sec-gap': '18px', 'page-header': '48px' });
    expect(tokens.radius['r-pill']).toBe('0');
  });
});

describe('restored tokens', () => {
  const all: Record<string, string> = {
    ...tokens.color.dark, ...tokens.type.size, ...tokens.radius, ...tokens.shadow,
  };
  it.each(['fs-watermark', 'fs-micro', 'tape-y', 'tape-c', 'tape-m', 'glow-accent', 'shadow-btn', 'shadow-tab', 'shadow-tab-lg', 'shadow-paper', 'r-opt', 'r-list'])('%s is a token', (key) => {
    expect(all[key]).toBeDefined();
  });

  it('folds the helper yellows into the one accent', () => {
    expect(tokens.color.dark.accent).toBe('#FFF100');
    for (const k of ['keyword', 'lemon', 'complete', 'tape-y', 'emph', 'now-line']) expect(tokens.color.dark[k], k).toBe('var(--ef-accent)');
  });
});

describe('category tokens', () => {
  it.each([
    ['cat-1', 'var(--ef-text-1)'],
    ['cat-2', 'var(--ef-text-2)'],
    ['cat-3', 'var(--ef-line-strong)'],
  ])('%s is %s in both themes', (key, value) => {
    expect(palette('dark')[key]).toBe(value);
    expect(palette('light')[key]).toBe(value);
  });

  it('category colours read at 3:1 on the page base in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const key of ['cat-1', 'cat-2', 'cat-3']) expect(contrast(resolve(theme, key), resolve(theme, 'base')), `${theme} ${key}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('other is the third ink grey; ink greys step from light to dark in dark and the reverse in light', () => {
    expect(tokens.color.dark['cat-other']).toBe('var(--ef-ink-s3)');
    const lum = (theme: Theme) => ['ink-s1', 'ink-s2', 'ink-s3'].map((k) => luminance(resolve(theme, k)));
    const [d1 = 0, d2 = 0, d3 = 0] = lum('dark');
    const [l1 = 0, l2 = 0, l3 = 0] = lum('light');
    expect(d1 > d2 && d2 > d3).toBe(true);
    expect(l1 < l2 && l2 < l3).toBe(true);
  });

  it('charts default to ink; the emphasis is the trace (yellow in dark, ink in light)', () => {
    expect(tokens.chart.dark['chart-s1']).toBe('var(--ef-ink-s1)');
    expect(tokens.chart.light['chart-s1']).toBe('var(--ef-ink-s1)');
    expect(resolve('dark', 'emph')).toBe(resolve('dark', 'accent'));
    expect(resolve('light', 'emph')).toBe(resolve('light', 'text-1'));
  });

  it('defines plate, row plate and glass for both themes; glass is an opaque surface and there is no sheen', () => {
    for (const key of ['plate-bg', 'plate-rim', 'plate-top', 'plate-sheen', 'rowplate', 'rowplate-hover', 'rowplate-ic', 'glass', 'glass-hover', 'glass-press', 'glass-rim', 'noise-a']) {
      expect(palette('dark')[key], key).toBeDefined();
      expect(palette('light')[key], `light ${key}`).toBeDefined();
    }
    expect(tokens.color.dark).toMatchObject({ glass: 'var(--ef-surface-2)', 'glass-hover': 'var(--ef-surface-3)', 'glass-press': 'var(--ef-surface-1)', 'glass-rim': 'var(--ef-line)' });
    for (const theme of ['dark', 'light'] as const) {
      expect(palette(theme)['plate-sheen'], theme).toBe('none');
      for (const key of ['glass', 'glass-hover', 'glass-press']) resolve(theme, key);
    }
    expect(tokens.color.dark['noise-a']).toBe('.02');
  });

  it('times panel-in, slash-wipe and page; reduced motion shortens them', () => {
    expect(tokens.motion.base).toMatchObject({ 'dur-panel-in': '220ms', 'dur-slash-wipe': '480ms', 'dur-page': '220ms' });
    expect(tokens.motion.reduceMotion).toMatchObject({ 'dur-panel-in': '120ms', 'dur-slash-wipe': '0ms', 'dur-page': '120ms' });
  });
});
