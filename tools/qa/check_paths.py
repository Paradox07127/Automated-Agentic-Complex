#!/usr/bin/env python3
"""Static path checks for a tree move. Exits 1 if any check fails.

usage: check_paths.py [--old PREFIX ...] [--links] [--components]
  --old     PREFIX must not appear in tracked code or config (*.md files are skipped).
  --links   also list Markdown links outside third-party vendor/ and references/ docs whose relative target does not exist.
  --components  also check that shipped source names another component's paths only where protocol/cross-paths.json allows it.
Always checks: every tracked symlink resolves, and nothing tracked under docs/ or in code links into notes/.
"""
import argparse, itertools, json, re, subprocess, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Records that keep historical paths on purpose: receipts and evidence are never rewritten after a move.
SKIP = re.compile(r'^(notes/|\.notes/)|/(evidence|revisions|receipts?)/|\.(md|tsv|log)$')
LINK = re.compile(r'\]\(([^)\s#]+)(?:#[^)]*)?\)')
CROSS = 'protocol/cross-paths.json'
# Files under a component root that do not ship in it.
NOT_SHIPPED = re.compile(r'(^|/)(tests?|Tests|fixtures|Fixtures|mock|fake)/|(^|/)test_[^/]*$|_test\.[a-z]+$'
                         r'|\.(test|spec)\.[a-z]+$|\.md$|\.generated\.')
# Also a POSIX ERE for git grep, so no (?: groups.
NAME = r'[A-Za-z0-9_][A-Za-z0-9_.-]*\.(json|jsonl|ndjson|sock|token|sqlite|log)|tts-token|agentic-complex-hook'


def git(*a):
    return subprocess.run(['git', '-C', str(ROOT), *a], capture_output=True, text=True).stdout


def strip_comment(line, mark):
    quote, j = None, 0
    while j < len(line):
        ch = line[j]
        if quote:
            if ch == '\\':
                j += 1
            elif ch == quote:
                quote = None
        elif ch in '"\'`':
            quote = ch
        elif line.startswith(mark, j) and line[j - 1:j] != ':':
            return line[:j]
        j += 1
    return line


def code_lines(path, text):
    """(line number, line) with comments and Python triple-quoted strings blanked."""
    ext = path.rsplit('.', 1)[-1]
    blank = lambda m: '\n' * m.group(0).count('\n')
    if ext in ('py', 'sh'):
        text = re.sub(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'', blank, text)
    elif ext != 'json':
        text = re.sub(r'/\*[\s\S]*?\*/', blank, text)
    mark = {'py': '#', 'sh': '#', 'json': None}.get(ext, '//')
    for i, line in enumerate(text.split('\n'), 1):
        yield i, strip_comment(line, mark) if mark else line


def components():
    """Rule A: a token owned by another component needs an allow entry. Rule B: a file name hard-coded in two
    components must be owned or ignored. Allow rows must be README table IDs, and each allowed file must still hit."""
    spec = json.loads((ROOT / CROSS).read_text())
    table = (ROOT / 'protocol/README.md').read_text().split('## 现行协议', 1)[1].split('\n## ', 1)[0]
    rows = set(re.findall(r'^\| ([^|\s]+) \|', table, re.M)) - {'ID'}
    owner = {t: c for c, ts in spec['owned'].items() for t in ts}
    tokens = sorted(owner, key=len, reverse=True)
    # A token with a file extension must start a string or follow '/', which drops prose and attribute names.
    # In shell an unquoted word is a path too, so there it may also follow whitespace, '=' or the line start.
    token_res = {sh: re.compile('|'.join(
        ((r'(?:(?<=[\s="\'`/])|^)' if sh else r'(?<=["\'`/])') if re.search(r'\.\w+$', t) else '')
        + re.escape(t) + r'(?![\w-])' for t in tokens)) for sh in (False, True)}
    name_re = re.compile(rf'(?<=["\'`/])({NAME})(?![\w-])')
    roots = sorted({p for ps in spec['roots'].values() for p in ps})
    comps = lambda f: {c for c, ps in spec['roots'].items() if any(f == p or p.endswith('/') and f.startswith(p) for p in ps)}
    cand = set(git('grep', '-l', '-I', '-F', *[x for t in tokens for x in ('-e', t)], '--', *roots).splitlines())
    cand |= set(git('grep', '-l', '-I', '-E', rf'["\'/]({NAME})', '--', *roots).splitlines())
    allowed = {(f, e['token']) for e in spec['allow'] for f in e['files']}
    used, fails, names = set(), [], defaultdict(list)
    for f in sorted(f for f in cand if not NOT_SHIPPED.search(f)):
        cs, token_re = comps(f), token_res[f.endswith('.sh')]
        for i, line in code_lines(f, (ROOT / f).read_text(errors='replace')):
            for m in token_re.finditer(line):
                t = m.group(0)
                if owner[t] in cs:
                    continue
                if (f, t) in allowed:
                    used.add((f, t))
                else:
                    fails.append(f'{f}:{i}: {t} belongs to {owner[t]}; allow it in {CROSS} under its README row')
            for m in name_re.finditer(line):
                if m.group(1) not in owner and m.group(1) not in spec['ignore']:
                    names[m.group(1)].append((f'{f}:{i}', cs))
    for n, hits in sorted(names.items()):
        if any(not a & b for (_, a), (_, b) in itertools.combinations(hits, 2)):
            fails += [f'{loc}: {n} is hard-coded in more than one component; add it to owned in {CROSS}, or to ignore'
                      for loc, _ in hits]
    for e in spec['allow']:
        if e['row'] not in rows:
            fails.append(f'{CROSS}: row {e["row"]} of {e["token"]} is not an ID in the protocol/README.md table')
        fails += [f'{CROSS}: {f} no longer has {e["token"]}' for f in e['files'] if (f, e['token']) not in used]
    print(f'cross-component paths: {len(cand)} candidate files, {len(used)} allowed (file, token) pairs, {len(fails)} failures')
    for x in fails:
        print('  ' + x)
    return bool(fails)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', action='append', default=[])
    ap.add_argument('--links', action='store_true')
    ap.add_argument('--components', action='store_true')
    a = ap.parse_args()
    bad = 0
    for prefix in a.old:
        hits = [h for h in git('grep', '-n', '-I', '-F', prefix).splitlines() if not SKIP.search(h.split(':', 1)[0])]
        print(f'old path {prefix}: {len(hits)} in code/config')
        for h in hits[:40]:
            print('  ' + h[:200])
        bad |= bool(hits)
    staged = git('ls-files', '-s').splitlines()
    links = [l.split('\t', 1)[1] for l in staged if l.startswith('120000')]
    dead = [l for l in links if not (ROOT / l).exists()]
    print(f'symlinks: {len(links)} tracked, {len(dead)} dangling')
    for l in dead:
        print('  ' + l)
    bad |= bool(dead)
    notes = [h for h in git('grep', '-n', '-I', '-E', r'(\]\(|["/])notes/').splitlines()
             if not SKIP.search(h.split(':', 1)[0]) or h.startswith('docs/')]
    notes = [h for h in notes if re.search(r'(^|[^.\w])notes/', h.split(':', 2)[2]) and '://' not in h]
    print(f'links into notes/: {len(notes)}')
    for h in notes[:40]:
        print('  ' + h[:200])
    bad |= bool(notes)
    if a.links:
        broken = []
        for f in git('ls-files', '*.md').splitlines():
            if '/vendor/' in f or '/references/' in f or not (ROOT / f).is_file():
                continue
            for target in LINK.findall((ROOT / f).read_text(errors='replace')):
                if '://' in target or target.startswith(('mailto:', '/')):
                    continue
                if not (ROOT / f).parent.joinpath(target).exists():
                    broken.append(f'{f}: {target}')
        print(f'broken md links: {len(broken)}')
        for b in broken[:60]:
            print('  ' + b)
    if a.components:
        bad |= components()
    print('CHECK-PATHS ' + ('FAIL' if bad else 'PASS'))
    sys.exit(1 if bad else 0)


main()
