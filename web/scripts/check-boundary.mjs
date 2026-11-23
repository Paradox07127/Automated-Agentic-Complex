// Lists production modules that import a demo module (mock data, the fake bridge, demo presets); exits 1 on any.
// Imports counted: static and type-only `import` / `export … from`, `import()` (also `typeof import()`), and `import.meta.glob` patterns.
// Comment lines are skipped. Files in scripts/check-boundary.allow pass for now; an entry that no longer imports demo code fails.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Whether a module (path from the web root, `src/…`) is demo code. */
export function inside(rel) {
  return (
    /^src\/(mock|bridge\/fake)\//.test(rel) || /\.demos\.tsx?$/.test(rel) || /^src\/pages\/[^/]+\/demos\.ts$/.test(rel)
  );
}

/** [file, specifier, reason]: imports into the boundary that the build already keeps out of the shipped app. */
export const EXCEPTIONS = [
  ['src/bridge/index.ts', './fake', 'the fake bridge type, the MODE === test import and the import guarded by MODE !== app'],
  ['src/shell/registry.ts', '../pages/*/demos.ts', 'the page presets glob sits behind MODE !== app'],
];

const CODE = /\.(ts|tsx|js|jsx|mjs|mts)$/;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (CODE.test(e.name)) yield p;
  }
}

const PATTERNS = [
  [/^\s*import\s*['"]([^'"\n]+)['"]/gm, 'import'],
  [/\bfrom\s*['"]([^'"\n]+)['"]/g, 'import'],
  [/\bimport\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g, 'import'],
  [/\bimport\.meta\.glob\b[^(]*\(\s*(\[[^\]]*\]|'[^'\n]*'|"[^"\n]*")/g, 'glob'],
];

/** [line, specifier, kind] of every import in a source file; kind `glob` is an `import.meta.glob` pattern. */
export function imports(src) {
  // Blank out comment lines so their text cannot match, keeping line numbers.
  const code = src
    .split('\n')
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l))
    .join('\n');
  const out = [];
  for (const [re, kind] of PATTERNS) {
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split('\n').length;
      const specs = kind === 'glob' ? [...m[1].matchAll(/['"]([^'"\n]+)['"]/g)].map((g) => g[1]) : [m[1]];
      for (const s of specs) out.push([line, s, kind]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function globRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Modules (paths from the web root) that one import of `from` reaches; empty for packages. */
function targets(from, spec, kind, files) {
  if (!spec.startsWith('.')) return [];
  const base = posix.join(posix.dirname(from), spec.replace(/\?.*$/, ''));
  if (kind === 'glob') {
    const re = globRegex(base);
    return files.filter((f) => re.test(f));
  }
  const tries = [base, ...['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map((x) => base + x)];
  return tries.filter((t) => files.includes(t)).slice(0, 1);
}

function readAllow(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Checks every module under `srcDir`, with the allowlist at `../scripts/check-boundary.allow` from it. `violations`:
 * `file:line  -> specifier` for each import of a module outside the boundary into it; `stale`: allowlist entries that
 * import nothing inside.
 */
export function run(srcDir) {
  const root = dirname(srcDir);
  const allow = readAllow(join(root, 'scripts', 'check-boundary.allow'));
  const files = [...walk(srcDir)].map((f) => relative(root, f).split('\\').join('/'));
  const violators = new Set();
  const violations = [];
  for (const file of files) {
    if (inside(file)) continue;
    for (const [line, spec, kind] of imports(readFileSync(join(root, file), 'utf8'))) {
      if (EXCEPTIONS.some(([f, s]) => f === file && s === spec)) continue;
      if (!targets(file, spec, kind, files).some(inside)) continue;
      violators.add(file);
      if (!allow.includes(file)) violations.push(`${file}:${line}  -> ${spec}`);
    }
  }
  const stale = allow.filter((f) => !violators.has(f));
  return { violations, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { violations, stale } = run(fileURLToPath(new URL('../src', import.meta.url)));
  for (const v of violations) console.error(v);
  for (const s of stale) console.error(`${s}  stale: imports no demo module, delete it from scripts/check-boundary.allow`);
  const n = violations.length + stale.length;
  console.log(n === 0 ? 'CHECK-BOUNDARY ok' : `CHECK-BOUNDARY fail ${n}`);
  process.exit(n === 0 ? 0 : 1);
}
