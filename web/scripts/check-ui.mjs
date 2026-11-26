// Counts UI drift per file under src/{pages,features,surfaces,shell} and fails when any count differs from
// scripts/check-ui.baseline.json, so the baseline only goes down. Kinds: `btn` a bare <button with className or style, or any
// element with role="button"; `fontPx` px font sizes (CSS font-size and the font shorthand, a numeric inline fontSize);
// `color` colour literals (hex, rgb/hsl, color(srgb), and white/black in CSS). Comments are blanked first.
// `--write-baseline` rewrites the baseline from the current code.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KINDS = ['btn', 'fontPx', 'color'];

const DIRS = ['pages', 'features', 'surfaces', 'shell'];
const SCANNED = /\.(tsx|ts|css)$/;

/** Whether a path from the web root is skipped: tests, demos. */
export function skipped(rel) {
  return /\.(test|spec)\.tsx?$/.test(rel) || /(^|\/)__tests__\//.test(rel) || /(^|\/)demos\.ts$/.test(rel) || /\.demos\.tsx?$/.test(rel);
}

/** `src` with comments replaced by spaces, newlines kept. `//` comments only when `css` is false. */
export function stripComments(src, css) {
  let out = '';
  let i = 0;
  // Stack of open template literals; each entry counts `{` opened inside its current `${…}`.
  const tpl = [];
  let inTpl = false;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inTpl) {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { inTpl = false; tpl.pop(); out += c; i += 1; continue; }
      if (c === '$' && n === '{') { inTpl = false; tpl[tpl.length - 1] = 0; out += '${'; i += 2; continue; }
      out += c; i += 1; continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    // After a colon `//` is a URL's (`https://` in JSX text), not a comment.
    if (!css && c === '/' && n === '/' && src[i - 1] !== ':') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quote string ends at its quote or the line end, so a stray apostrophe in JSX text spoils one line at most.
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const stop = src[j] === c ? j + 1 : j;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (!css && c === '`') { tpl.push(0); inTpl = true; out += c; i += 1; continue; }
    if (!css && tpl.length > 0 && c === '{') tpl[tpl.length - 1] += 1;
    if (!css && tpl.length > 0 && c === '}') {
      if (tpl[tpl.length - 1] === 0) { inTpl = true; out += c; i += 1; continue; }
      tpl[tpl.length - 1] -= 1;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The attribute text of the JSX opening tag whose name ends at `from`, up to its closing `>`. */
function tagAttrs(code, from) {
  let depth = 0;
  let quote = '';
  for (let j = from; j < code.length; j += 1) {
    const c = code[j];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (depth === 0 && (c === '"' || c === "'")) { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return code.slice(from, j);
  }
  return code.slice(from);
}

function lineOf(code, index) {
  return code.slice(0, index).split('\n').length;
}

/** Line numbers of every hit of each kind in one file (path from the web root). */
export function hits(rel, src) {
  const css = rel.endsWith('.css');
  const code = stripComments(src, css);
  const out = Object.fromEntries(KINDS.map((k) => [k, []]));
  if (!css) {
    for (const m of code.matchAll(/<button\b/g)) {
      if (/\b(?:className|style)\b/.test(tagAttrs(code, m.index + m[0].length))) out.btn.push(lineOf(code, m.index));
    }
    // A component (capitalised tag) may take role="button" for its own reasons; a DOM element with it is a bare button.
    for (const m of code.matchAll(/<(?!button\b)[a-z][\w-]*\b/g)) {
      if (/\brole\s*=\s*(?:"button"|'button'|\{\s*['"]button['"]\s*\})/.test(tagAttrs(code, m.index + m[0].length))) out.btn.push(lineOf(code, m.index));
    }
    for (const m of code.matchAll(/\bfontSize\s*:\s*(?:\d|['"`]\d*\.?\d+px\b)/g)) out.fontPx.push(lineOf(code, m.index));
  }
  if (css) {
    for (const m of code.matchAll(/\bfont-size\s*:\s*\d*\.?\d+px\b/g)) out.fontPx.push(lineOf(code, m.index));
    // The shorthand's size follows its optional style, variant, weight and stretch words.
    for (const m of code.matchAll(/(?<![\w-])font\s*:\s*(?:(?:[a-z-]+|\d{3}|var\(--[\w-]+\))\s+)*\d*\.?\d+px\b/g)) out.fontPx.push(lineOf(code, m.index));
    for (const m of code.matchAll(/:([^;{}]*)/g)) {
      for (const n of m[1].matchAll(/(?<![\w.#/-])(?:white|black)(?![\w-])/g)) out.color.push(lineOf(code, m.index + 1 + n.index));
    }
  }
  for (const m of code.matchAll(/(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(|\bcolor\(\s*srgb\b/g)) {
    out.color.push(lineOf(code, m.index));
  }
  for (const k of KINDS) out[k].sort((a, b) => a - b);
  return out;
}

/** The non-zero counts of each kind in one file. */
export function count(rel, src) {
  const h = hits(rel, src);
  const out = {};
  for (const k of KINDS) if (h[k].length > 0) out[k] = h[k].length;
  return out;
}

/**
 * Compares current counts (`file → kind → n`, non-zero only) with the baseline. `over`: [file, kind, now, base] that
 * rose above the baseline; `loose`: the same for counts that fell below it. `ok` only when neither has a row.
 */
export function compare(current, baseline) {
  const over = [];
  const loose = [];
  const files = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort();
  for (const f of files) {
    for (const k of KINDS) {
      const now = current[f]?.[k] ?? 0;
      const base = baseline[f]?.[k] ?? 0;
      if (now > base) over.push([f, k, now, base]);
      else if (now < base) loose.push([f, k, now, base]);
    }
  }
  return { over, loose, ok: over.length === 0 && loose.length === 0 };
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (SCANNED.test(e.name)) yield p;
  }
}

/** Current counts for every scanned file under `root` (the web root): `file → kind → n`, non-zero only. */
export function scan(root) {
  const out = {};
  for (const d of DIRS) {
    for (const file of walk(join(root, 'src', d))) {
      const rel = relative(root, file).split('\\').join('/');
      if (skipped(rel)) continue;
      const c = count(rel, readFileSync(file, 'utf8'));
      if (Object.keys(c).length > 0) out[rel] = c;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const baseFile = join(root, 'scripts', 'check-ui.baseline.json');
  const current = scan(root);
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(baseFile, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`CHECK-UI baseline written: ${Object.keys(current).length} files`);
    process.exit(0);
  }
  const baseline = existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, 'utf8')) : {};
  const { over, loose, ok } = compare(current, baseline);
  for (const [f, k, now, base] of loose) console.error(`${f} ${k} ${now}<${base}`);
  if (loose.length > 0) console.error('计数已下降：同一提交里跑 npm run check:ui -- --write-baseline，把基线收紧到当前值。');
  for (const [f, k, now, base] of over) {
    const src = readFileSync(join(root, f), 'utf8');
    const line = hits(f, src)[k][0];
    console.error(`${f} ${k} ${now}>${base}`);
    console.error(`  ${line}: ${src.split('\n')[line - 1].trim()}`);
  }
  if (over.length > 0) console.error('用 src/ui 的组件和 tokens.json 的 token 代替；确实要新增时，同一提交里跑 npm run check:ui -- --write-baseline 并在提交说明里写原因。');
  console.log(ok ? 'CHECK-UI ok' : `CHECK-UI fail ${over.length + loose.length}`);
  process.exit(ok ? 0 : 1);
}
