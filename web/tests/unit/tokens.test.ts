// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderTokensCss, type Tokens } from '../../src/design/gen-tokens.ts';
import tokensJson from '../../src/design/tokens.json';

const tokens = tokensJson as unknown as Tokens;
const cssPath = fileURLToPath(new URL('../../src/design/tokens.css', import.meta.url));

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

// [foreground, background] pairs that carry body or label text; each must reach 4.5:1 in both themes.
const textPairs: Array<[string, string]> = [
  ['text-1', 'base'],
  ['text-1', 'canvas'],
  ['text-1', 'surface-1'],
  ['text-1', 'raised'],
  ['text-1', 'surface-2'],
  ['text-2', 'base'],
  ['text-2', 'canvas'],
  ['text-2', 'surface-1'],
  ['text-2', 'raised'],
  ['text-3', 'base'],
  ['text-3', 'canvas'],
  ['text-3', 'raised'],
  ['on-accent', 'accent'],
  ['field-text', 'field'],
  ['paper-text', 'paper'],
  ['paper-text-2', 'paper'],
  ['row-sel-fg', 'row-sel-bg'],
  ['on-attention', 'attention'],
  ['on-danger', 'danger'],
  ['on-danger-strong', 'danger-strong'],
  ['attention-text', 'base'],
  ['danger-text', 'base'],
  ['success-text', 'base'],
  ['info-text', 'base'],
  ['accent-text', 'base'],
  ['btn-light-text', 'btn-light'],
  ['btn-accent-text', 'accent'],
  ['btn-dark-text', 'btn-dark'],
  ['on-danger-vivid', 'danger-vivid'],
  ['mission-accent', 'base'],
  ['on-mission-accent', 'mission-accent'],
  ['newtag-text', 'accent'],
  ['popup-text', 'popup-band'],
  ['popup-sub', 'popup-band'],
  ['toggle-off-text', 'toggle-track'],
  ['paper-toggle-off-text', 'paper-toggle-track'],
  ['dropdown-text', 'dropdown-field'],
  ['dropdown-opt-text', 'dropdown-list'],
  ['tab2-text', 'base'],
  ['tab2-text', 'raised'],
  ['tab2-sel-text', 'tab2-sel-bg'],
  ['set-title', 'base'],
  ['danger-conflict', 'base'],
];

// [foreground, background] pairs for graphics (edges, category bars); each must reach 3:1.
const graphicPairs: Array<[string, string]> = [
  ['mission', 'surface-1'],
  ['mission', 'base'],
  ['btn-dark', 'popup-band'],
  ['danger-vivid', 'base'],
  ['mission-accent', 'base'],
  ['mission-accent', 'surface-1'],
  ['badge-dot', 'base'],
  ['badge-dot', 'surface-1'],
  ['toggle-knob', 'toggle-track'],
  ['toggle-track', 'base'],
  ['paper-toggle-knob', 'paper'],
  ['paper-toggle-knob', 'paper-toggle-track'],
  ['slider-handle', 'base'],
  ['tab2-sel-bg', 'base'],
  ['tabpc-sel-icon', 'accent'],
  ['power-low', 'base'],
  ['power-low', 'surface-1'],
  ['success-green', 'base'],
  ['success-green', 'surface-1'],
];

describe('tokens.css', () => {
  it('matches a fresh render of tokens.json byte for byte', () => {
    expect(readFileSync(cssPath, 'utf8')).toBe(renderTokensCss(tokens));
  });

  it('declares every themed token in both theme blocks', () => {
    const css = renderTokensCss(tokens);
    const light = css.slice(css.indexOf('[data-theme="light"] {'));
    for (const key of Object.keys(tokens.color.dark)) expect(light).toContain(`--ef-${key}:`);
  });
});

describe('contrast', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const [fg, bg] of textPairs) {
      it(`${theme}: ${fg} on ${bg} >= 4.5`, () => {
        expect(contrast(resolve(theme, fg), resolve(theme, bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of graphicPairs) {
      it(`${theme}: ${fg} on ${bg} >= 3`, () => {
        expect(contrast(resolve(theme, fg), resolve(theme, bg))).toBeGreaterThanOrEqual(3);
      });
    }
    // The side away from the knob rests dimmed by the stylesheet's opacity; its blend over the track is what is read.
    for (const ui of ['Switch', 'Toggle']) {
      for (const pre of ['', 'paper-']) {
        it(`${theme}: ${ui} ${pre}toggle-off-text at rest opacity on ${pre}toggle-track >= 4.5`, () => {
          const css = readFileSync(fileURLToPath(new URL(`../../src/ui/${ui}.module.css`, import.meta.url)), 'utf8');
          const alpha = Number(/\n\.side \{[^}]*?opacity: ([\d.]+);/.exec(css)?.[1]);
          expect(alpha).toBeGreaterThan(0);
          const fg = resolve(theme, `${pre}toggle-off-text`);
          const track = resolve(theme, `${pre}toggle-track`);
          const blend = `#${[1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(track.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
          expect(contrast(blend, track)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

/** The last token name an alias chain reaches before a literal value. */
function aliasRoot(theme: Theme, name: string): string {
  const p = palette(theme);
  let key = name;
  for (let i = 0; p[key]?.startsWith('var(--ef-') && i < 5; i++) key = p[key]!.slice(9, -1);
  return key;
}

function isRed(hex: string): boolean {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 0.25 || max !== r) return false;
  const hue = (((g - b) / chroma) * 60 + 360) % 360;
  return hue < 20 || hue > 340;
}

describe('one accent, ink states', () => {
  // state-idle is the empty-cell fill, not a hue.
  const stateKeys = [
    ...Object.keys(tokens.color.dark).filter((k) => k.startsWith('state-') && k !== 'state-idle'),
    'attention', 'attention-text', 'success', 'success-text', 'info', 'info-text', 'mission',
  ];

  for (const theme of ['dark', 'light'] as const) {
    it.each(stateKeys)(`${theme}: %s resolves to the accent or an ink`, (key) => {
      expect(['accent', 'accent-text', 'text-1', 'text-2', 'text-3']).toContain(aliasRoot(theme, key));
    });

    it(`${theme}: danger is the only red`, () => {
      for (const key of Object.keys(palette(theme))) {
        const v = palette(theme)[key]!;
        if (!/^#[0-9A-F]{6}$/i.test(v) || !isRed(v)) continue;
        expect(key, `${key} ${v}`).toMatch(/^danger/);
      }
      expect(isRed(resolve(theme, 'danger'))).toBe(true);
    });
  }

  it('maps each state to its ink or the accent', () => {
    expect(tokens.color.dark).toMatchObject({
      'state-ok': 'var(--ef-text-1)',
      'state-running': 'var(--ef-text-1)',
      'state-failed': 'var(--ef-accent)',
      'state-waiting': 'var(--ef-accent)',
      'state-warning': 'var(--ef-accent)',
      'state-cancelled': 'var(--ef-text-3)',
    });
  });
});

describe('new-style tokens', () => {
  const css = renderTokensCss(tokens);
  const darkBlock = css.slice(0, css.indexOf('[data-theme="light"] {'));
  const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf('\n:root {'));
  const rootBlock = css.slice(css.indexOf('\n:root {'));

  it.each(['trace', 'chip', 'tag-bg', 'tag-fg', 'hatch', 'contour', 'tri-a', 'tri-b', 'tri-c'])('%s is in both theme blocks', (key) => {
    expect(darkBlock).toContain(`--ef-${key}:`);
    expect(lightBlock).toContain(`--ef-${key}:`);
  });

  it.each(['cut', 'cut-btn', 'cut-panel', 'font-ui', 'ease-snap', 'ease-mech', 'wide', 'wider'])('%s is in :root', (key) => {
    expect(rootBlock).toContain(`--ef-${key}:`);
  });

  it('draws the trace in the accent on dark and in ink on light', () => {
    expect(aliasRoot('dark', 'trace')).toBe('accent');
    expect(aliasRoot('light', 'trace')).toBe('text-1');
  });

  it('sets every radius to 0 and the HUD shadows to none', () => {
    for (const [k, v] of Object.entries(tokens.radius)) expect(v, k).toBe('0');
    for (const theme of ['dark', 'light'] as const) {
      for (const k of ['shadow-hud', 'text-shadow-hud', 'plate-sheen']) expect(palette(theme)[k], `${theme} ${k}`).toBe('none');
    }
  });

  // The game's light falls from above left: a shadow sits right of and below its element, nothing shows above.
  it.each(['shadow-btn', 'shadow-card', 'shadow-popup'])('%s casts down and right in both themes', (key) => {
    for (const theme of ['dark', 'light'] as const) {
      const [x = 0, y = 0, blur = 0, spread = 0] = palette(theme)[key]!.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+(?=px|\s|$)/g)!.map(Number);
      expect(x, `${theme} ${key} x`).toBeGreaterThanOrEqual(0);
      expect(y, `${theme} ${key} y`).toBeGreaterThan(0);
      expect(blur + spread - y, `${theme} ${key} above`).toBeLessThanOrEqual(2);
    }
  });

  it('sets the wide Latin face first in every UI font stack', () => {
    for (const k of ['font-ui', 'font-wide', 'font-num', 'font-din']) expect(tokens.type.family[k], k).toMatch(/^"Saira Variable",/);
    expect(tokens.type.family['font-num']).toMatch(/^"Saira Variable","Noto Sans SC",/);
  });

  it('keeps chart colours on the ink scale', () => {
    for (const theme of ['dark', 'light'] as const) {
      const chart = theme === 'dark' ? tokens.chart.dark : { ...tokens.chart.dark, ...tokens.chart.light };
      for (const [k, v] of Object.entries(chart)) {
        if (!/^#[0-9A-F]{6}$/i.test(v)) continue;
        const c = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
        expect(Math.max(...c) - Math.min(...c), `${theme} ${k} ${v}`).toBeLessThanOrEqual(8);
      }
    }
  });
});
