// Lists banned on-screen strings (dev notes, issue numbers, `//`, bilingual labels) as file:line; exits 1 on any hit.
// On-screen = string literals and JSX text in .ts/.tsx, and `content:` values in .css; comments are skipped.
// Decoration strings (`//`, APPROVAL, NOW) pass inside an aria-hidden element.
// Visible wording that has been replaced, anywhere under src/, fails it too.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dirs = ['src/pages', 'src/features', 'src/surfaces', 'src/ui', 'src/charts'];

export const RULES = [
  ['需新增', /需新增/],
  ['未核实', /未核实/],
  ['需要后端', /需要后端/],
  ['issue 编号', /(?<![\w&/-])#\d+(?![\w-])/],
  ['//', /(?<!:)\/\//],
  ['Needs you', /Needs you/i],
  ['APPROVAL', /\bAPPROVAL\b/],
  ['Delivery //', /Delivery\s*\/\//],
  ['PlanNN', /\bPlan\s?(\d|\$\{|\{|$)/],
  ['ROLE', /\bROLE\b/],
  ['NOW', /\bNOW\b/],
  ['内部字段名', /\b(policy_epoch|t_wall|duration_ms|lean_edge|conversation_id)\b/],
  ['暂无', /暂无/],
  ['数据停在 —', /数据停在\s*[—–-]/],
  // Meta items are split by ` │ `; a `·` inside a Chinese phrase (免打扰·安静) has no space beside it.
  ['· 分隔', /\s·|·\s/],
];

/** Rules that let a string through when it sits in an aria-hidden element. */
export const DECOR = new Set(['//', 'APPROVAL', 'NOW']);

/** Replaced wording. Short words that also occur inside other words only match a whole string. */
export const OLD_WORDS = [
  ['看一下', /看一下/],
  ['就地输入', /就地输入/],
  ['交派任务', /交派任务/],
  ['派任务', /(?<!交)派任务/],
  ['交给角色', /交给角色/],
  ['需要你', /需要你/],
  ['等你', /等你/],
  ['正在进行', /正在进行/],
  ['今日报告', /今日报告/],
  ['你在做', /你在做/],
  ['她说', /她说/],
  ['情节', /情节/],
  ['节拍', /节拍/],
  ['干员', /干员/],
  // The character is not always female; on-screen text says 角色 or the character's name.
  ['她', /她/],
  ['调校', /调校/],
  ['在桌面播', /在桌面播/],
  ['关于你', /关于你/],
  ['她这样认识你', /她这样认识你/],
  ['待你确认', /待你确认/],
  ['你说的', /你说的/],
  ['说过', /^\s*说过\s*$/],
  ['看到', /^\s*看到\s*$/],
  ['对', /^\s*对\s*$/],
  ['改一下', /改一下/],
  ['不对', /^\s*不对\s*$/],
  ['别再猜这类', /别再猜这类/],
  ['忘记', /^\s*忘记\s*$/],
  ['别再提', /别再提/],
  ['记住了 N 条', /记住了\s*\S+\s*条/],
  ['用到 N 条记忆', /用到\s*\S+\s*条记忆/],
  ['不再看', /不再看/],
  ['删除这段', /删除这段/],
  ['回合', /回合/],
  ['她主动', /她主动/],
  ['拦下', /拦下/],
  ['退回', /(?<!已)退回/],
  ['看诊断', /(?<!查)看诊断/],
  ['去设置', /去设置/],
  ['看原句', /看原句/],
  ['待审批', /待审批/],
  ['执行工具', /^\s*执行工具(\s*$| [·│] )/],
  ['运行工具', /^\s*运行工具(\s*$| [·│] )/],
  ['等待审批', /等待审批/],
  ['只出字', /只出字/],
  ['看多细', /看多细/],
  ['名单外都读', /名单外都读/],
  ['只读名单里的', /只读名单里的/],
  ['派活', /派活/],
  ['外壳', /外壳/],
  ['热键', /热键/],
  ['在想', /在想/],
  ['在跑', /在跑/],
  ['在后台做', /在后台做/],
  ['没有新动静', /没有新动静/],
  ['回执不全', /回执不全/],
  ['没有回应', /没有回应/],
  ['这个版本还不支持', /这个版本还不支持/],
];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const HIDDEN_ATTR = /\saria-hidden(?:=(?:"true"|'true'|\{true\}))?(?=[\s/>])/;

/** [line, text, hidden] pieces of a TS/TSX file that can reach the screen; hidden marks text inside an aria-hidden element. */
export function tsPieces(src) {
  const out = [];
  let line = 1;
  let i = 0;
  // Set when JSX text stops at `{`: that brace opens a child expression, and text may follow its `}`.
  let childOpen = false;
  // Index of the closing tag of the outermost open aria-hidden element; everything before it is hidden.
  let hiddenUntil = -1;
  const n = src.length;
  const newlines = (s) => s.split('\n').length - 1;

  // Called at the `>` of an aria-hidden opening tag that starts at `open`: hides up to its matching closing tag.
  function hideElement(open) {
    const name = src.slice(open + 1).match(/^[A-Za-z][\w.$-]*/)?.[0];
    if (!name || src[i - 1] === '/') return;
    const tag = new RegExp(`<(/?)${name.replace(/[.$]/g, '\\$&')}(?=[\\s/>])`, 'g');
    tag.lastIndex = i;
    let depth = 1;
    for (let m = tag.exec(src); m; m = tag.exec(src)) {
      if (m[1]) depth -= 1;
      else if (!selfClosing(m.index)) depth += 1;
      if (depth === 0) {
        hiddenUntil = Math.max(hiddenUntil, m.index);
        return;
      }
    }
  }

  // Whether the tag starting at `at` ends in `/>`; a `>` after `=` belongs to an arrow function in an attribute.
  function selfClosing(at) {
    let k = src.indexOf('>', at);
    while (k > 0 && src[k - 1] === '=') k = src.indexOf('>', k + 1);
    return k > 0 && src[k - 1] === '/';
  }

  function quoted(q) {
    const start = line;
    const hidden = i < hiddenUntil;
    let s = '';
    i += 1;
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') {
        s += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      s += src[i];
      i += 1;
    }
    if (src[i] === q) i += 1;
    out.push([start, s, hidden]);
  }

  // `${…}` parts are scanned as code (their own strings still count) and stand in as `…` here.
  function template() {
    const start = line;
    const hidden = i < hiddenUntil;
    let s = '';
    i += 1;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        s += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        code(true);
        s += '…';
        continue;
      }
      if (src[i] === '\n') line += 1;
      s += src[i];
      i += 1;
    }
    i += 1;
    out.push([start, s, hidden]);
  }

  // JSX text: between a tag's `>` or a child expression's `}` and the next `<` or `{`; text with quotes is left to the code scan.
  function jsxText() {
    // A `>` whose `<` follows an identifier closes a type argument (`Promise<void> {`), not a tag.
    const open = src[i] === '>' ? src.lastIndexOf('<', i - 1) : -1;
    if (open > 0 && /[\w$]/.test(src[open - 1])) return false;
    if (open >= 0 && HIDDEN_ATTR.test(src.slice(open, i + 1))) hideElement(open);
    let j = i + 1;
    while (j < n && !'<{}>;='.includes(src[j])) j += 1;
    const t = src.slice(i + 1, j);
    if (!(src[j] === '<' || src[j] === '{') || /['"`]/.test(t)) return false;
    childOpen = src[j] === '{';
    if (!/\S/.test(t)) return false;
    out.push([line + newlines(t.match(/^\s*/)[0]), t, i < hiddenUntil]);
    line += newlines(t);
    i = j;
    return true;
  }

  // Scans code; inside a template expression it returns after the closing `}`.
  function code(inExpr) {
    let depth = 0;
    const children = [];
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === '/' && next === '/') {
        while (i < n && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        line += newlines(src.slice(i, stop));
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        quoted(c);
        continue;
      }
      if (c === '`') {
        template();
        continue;
      }
      if (c === '>' && src[i - 1] !== '=' && jsxText()) continue;
      if (c === '{') {
        depth += 1;
        children.push(childOpen);
        childOpen = false;
      }
      if (c === '}') {
        if (inExpr && depth === 0) {
          i += 1;
          return;
        }
        depth -= 1;
        if (children.pop() && jsxText()) continue;
      }
      if (c === '\n') line += 1;
      i += 1;
    }
  }

  code(false);
  return out;
}

/** [line, text] of every CSS `content:` value. */
export function cssPieces(src) {
  const out = [];
  src.split('\n').forEach((l, k) => {
    const m = l.match(/content:\s*(.+?);?\s*$/);
    if (m) out.push([k + 1, m[1]]);
  });
  return out;
}

/** `line  [rules]  text` for each on-screen piece of one source file that breaks a rule. */
export function copyHits(file, src) {
  let pieces;
  if (/\.tsx?$/.test(file)) pieces = tsPieces(src);
  else if (file.endsWith('.css')) pieces = cssPieces(src);
  else return [];
  const out = [];
  for (const [line, text, hidden] of pieces) {
    const broken = RULES.filter(([name, re]) => re.test(text) && !(hidden && DECOR.has(name))).map(([name]) => name);
    if (broken.length > 0) out.push(`${line}  [${broken.join(', ')}]  ${text.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  return out;
}

/** Files of character-authored text (lines in the character's voice) that may call a third person 她. */
export const CHARACTER_TEXT = ['src/mock/fixtures/chatDemo.ts'];

/** `line  [old words]  text` for each visible TS/TSX string that still uses replaced wording. */
export function oldWordHits(file, src) {
  if (!/\.tsx?$/.test(file)) return [];
  const voiced = CHARACTER_TEXT.some((f) => file.split('\\').join('/').endsWith(f));
  const words = voiced ? OLD_WORDS.filter(([name]) => name !== '她') : OLD_WORDS;
  const out = [];
  for (const [line, text] of tsPieces(src)) {
    const old = words.filter(([, re]) => re.test(text)).map(([name]) => name);
    if (old.length > 0) out.push(`${line}  [${old.join(', ')}]  ${text.trim().replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  return out;
}

// A `title=` whose value is the literal, bare or as a ternary branch; a `??` fallback (a disabled control's reason) passes.
const UNSUPPORTED_TITLE = /\btitle=(?:(["'])后台暂不提供\1|\{[^{}]*?(?:[^?]\?|:)\s*(["'])后台暂不提供\2[^{}]*\})/g;

/** `line  [title 后台暂不提供]  attribute` for each such title in a TSX file; the field shows <Missing why="unsupported" /> instead. */
export function titleHits(file, src) {
  if (!file.endsWith('.tsx')) return [];
  return [...src.matchAll(UNSUPPORTED_TITLE)].map((m) => `${src.slice(0, m.index).split('\n').length}  [title 后台暂不提供]  ${m[0].replace(/\s+/g, ' ')}`);
}

/** Checks the tree under `root`, prints the hits and returns the exit code. */
export function run(root) {
  // One entry per file:line and text, naming every rule it breaks.
  const hits = new Set();
  for (const d of dirs) {
    for (const file of walk(join(root, d))) {
      const rel = relative(root, file).split('\\').join('/');
      const src = readFileSync(file, 'utf8');
      for (const h of [...copyHits(file, src), ...titleHits(file, src)]) hits.add(`${rel}:${h}`);
    }
  }

  const old = [];
  for (const file of walk(join(root, 'src'))) {
    const rel = relative(root, file).split('\\').join('/');
    for (const h of oldWordHits(file, readFileSync(file, 'utf8'))) old.push(`${rel}:${h}`);
  }

  if (old.length > 0) {
    console.error(`COPY FAIL: ${old.length} string(s) use wording replaced by 53 §1`);
    for (const h of old) console.error(`  ${h}`);
  }
  if (hits.size > 0) {
    console.error(`COPY FAIL: ${hits.size} hit(s)`);
    for (const h of hits) console.error(`  ${h}`);
  }
  if (old.length > 0 || hits.size > 0) return 1;
  console.log('COPY PASS: no banned on-screen strings');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(run(fileURLToPath(new URL('..', import.meta.url))));
}
