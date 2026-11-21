// Fails when any file under src/ (except the token data tokens.json, the generated tokens.css and *.generated.ts) exceeds the line limit.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 400;
const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const exempt = new Set(['src/design/tokens.json', 'src/design/tokens.css']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const over = [];
let count = 0;
for (const file of walk(src)) {
  const rel = relative(root, file).split('\\').join('/');
  if (exempt.has(rel) || rel.endsWith('.generated.ts')) continue;
  count += 1;
  const text = readFileSync(file, 'utf8');
  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > LIMIT) over.push(`${rel}: ${lines} lines`);
}

if (over.length > 0) {
  console.error(`SIZE FAIL: ${over.length} file(s) over ${LIMIT} lines`);
  for (const o of over) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`SIZE PASS: ${count} files, all <= ${LIMIT} lines`);
