// tokens.json -> tokens.css. Run with `npm run gen:tokens` (plain node, type stripping).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Vars = Record<string, string>;
type Themed = { dark: Vars; light: Vars };

export interface Tokens {
  color: Themed;
  chart: Themed;
  hud: { base: Vars; reduceTransparency: Vars };
  /** `role` holds `font` shorthands for the type roles (`font: var(--ef-t-h1)`). */
  type: { family: Vars; size: Vars; weight: Vars; lineHeight: Vars; role: Vars };
  space: Vars;
  size: Vars;
  radius: Vars;
  line: Vars;
  shadow: Vars;
  z: Vars;
  motion: { base: Vars; reduceMotion: Vars };
  /** Overrides for windows under 700 px high: tighter section gap and header. */
  compactHeight: Vars;
}

export const HEADER = '/* 生成文件，勿手改。来源 src/design/tokens.json，运行 npm run gen:tokens 重新生成。 */';

function block(selector: string, vars: Vars, extra: string[] = []): string {
  const lines = [...extra, ...Object.entries(vars).map(([k, v]) => `--ef-${k}: ${v};`)];
  return `${selector} {\n${lines.map((l) => `  ${l}`).join('\n')}\n}`;
}

function media(query: string, inner: string): string {
  return `@media ${query} {\n${inner.split('\n').map((l) => `  ${l}`).join('\n')}\n}`;
}

function assertUnique(groups: Vars[]): void {
  const seen = new Set<string>();
  for (const g of groups) {
    for (const k of Object.keys(g)) {
      if (seen.has(k)) throw new Error(`duplicate token key: ${k}`);
      seen.add(k);
    }
  }
}

export function renderTokensCss(t: Tokens): string {
  const shared: Vars[] = [
    t.hud.base, t.type.family, t.type.size, t.type.weight, t.type.lineHeight, t.type.role,
    t.space, t.size, t.radius, t.line, t.shadow, t.z, t.motion.base,
  ];
  assertUnique([t.color.dark, t.chart.dark, ...shared]);
  const dark = { ...t.color.dark, ...t.chart.dark };
  // Light repeats every themed key so a nested [data-theme] subtree resolves aliases on itself.
  const light = { ...t.color.dark, ...t.color.light, ...t.chart.dark, ...t.chart.light };
  const rest = Object.assign({}, ...shared) as Vars;
  return [
    HEADER,
    block(':root,\n[data-theme="dark"]', dark, ['color-scheme: dark;']),
    block('[data-theme="light"]', light, ['color-scheme: light;']),
    block(':root', rest),
    media('(prefers-reduced-transparency: reduce)', block(':root', t.hud.reduceTransparency)),
    block('[data-reduce-transparency]', t.hud.reduceTransparency),
    media('(prefers-reduced-motion: reduce)', block(':root', t.motion.reduceMotion)),
    block('[data-reduce-motion]', t.motion.reduceMotion),
    media('(max-height: 699px)', block(':root', t.compactHeight)),
  ].join('\n\n') + '\n';
}

const here = fileURLToPath(new URL('.', import.meta.url));

export function generate(): string {
  const tokens = JSON.parse(readFileSync(`${here}tokens.json`, 'utf8')) as Tokens;
  return renderTokensCss(tokens);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(`${here}tokens.css`, generate());
}
