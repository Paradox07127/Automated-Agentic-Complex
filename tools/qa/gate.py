#!/usr/bin/env python3
"""Runs one profile of tools/qa/suites.json and writes a gate receipt (tools/release/gate_receipt.py).
When private/suites.json exists, its suites join the gate and its phases follow those of the same-named profile.

Usage: gate.py --profile <name> [--checkout <dir>] [--logs <dir>] [--perf] [--jobs N] [--only a,b | --changed <base>]
       [--no-cache] [--dry-run] | --list
--changed runs only the suites whose paths hold a file changed since <base> (committed, staged, unstaged or untracked,
or under a suite path git ignores and modified after <base>'s commit time), plus the suites they require; a changed
file that no suite and no_suite lists runs the full profile, and so does no changed file unless the profile sets
"empty_changes": "none".
Phases run one after another, the lanes of a phase at once. Prints each suite's result lines in profile order, then
`receipt: <path>` and GATE PASS or GATE FAIL; exits 1 on failure. Without --logs the logs are deleted after the run.
A suite with paths, outside a lock block and not fatal reuses a stored PASS of the same inputs (see cache_keys) unless
another suite that runs requires it; --no-cache reads no stored result. A run whose sources did not change stores the
PASS of each such suite it ran under <main checkout>/.local/cache/gate-results/, shared by all worktrees.
A suite's "os" lists the systems it runs on (default macos). A suite with "host": "win" runs on the Windows build host:
outside Windows, gate.py runs it through HOST_RUNNER test (private; absent in a public checkout), which runs it there in the win-ci profile; only
win-* profiles may hold such a suite, and it reuses no stored result.
A suite that runs longer than its "timeout" seconds (default 1800; each module of a suite with modules) is killed with
its process group and fails.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import contextlib
import dataclasses
import datetime
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
RUNNER_ROOT = HERE.parents[1]
TOOLS = RUNNER_ROOT / 'tools/release'
sys.path.insert(0, str(TOOLS))
import gate_receipt
import release
import source_fingerprint

SCHEMA = 'endfield-gate-suites/v1'
SUITES_FILE = HERE / 'suites.json'
PRIVATE_SUITES_FILE = RUNNER_ROOT / 'private/suites.json'
HOST_RUNNER = 'private/remote/winhost.py'
NZ = 'FAIL: suite above exited non-zero'
VERDICT = re.compile(r'FAIL|[1-9][0-9]* (failure|failed)')
LOCKED_NEEDS = {'window', 'gpu'}
NEEDS = LOCKED_NEEDS | {'private_assets', 'model'}
SYSTEMS = {'macos', 'windows'}
# Companion's own agentd port; no gate suite may use it.
FORBIDDEN_PORT = '48800'
# A stored suite result older than this many days is deleted when its suite stores a new one.
CACHE_DAYS = 14
# Build output under a path git ignores (private/renderer/core/build): keying on it would change the key on every build.
UNHASHED_DIRS = {*source_fingerprint.EXCLUDED_PARTS, 'build', 'obj', '.venv'}
# Seconds a suite (each module of a suite with modules) may run when it sets no "timeout".
SUITE_TIMEOUT = 1800


@dataclasses.dataclass
class SuiteResult:
    id: str
    lines: list
    status: str
    exit: int
    tests: object = None
    failures: object = None
    skipped: object = None
    seconds: float = 0.0
    lock: object = None
    log: object = None
    cached: object = None


# Parsers: (suite, output, exit code, module results or None) -> dict(lines, tests, failures, skipped, ok, nz).
# ok False fails the suite; nz True prints NZ as a non-zero exit would.

def _numbers(pattern, text):
    return [int(m.group(1)) for m in re.finditer(pattern, text)]


def parse_exit(suite, output, code, modules):
    line = suite.get('line') or {}
    text = line.get('pass' if code == 0 else 'fail')
    return dict(lines=[text] if text else [])


def parse_build(suite, output, code, modules):
    parsed = parse_exit(suite, output, code, modules)
    if code != 0:
        parsed['lines'] = output.splitlines()[-20:] + parsed['lines']
    return parsed


def parse_tail1(suite, output, code, modules):
    return dict(lines=output.splitlines()[-1:])


def parse_last_passfail(suite, output, code, modules):
    found = [line for line in output.splitlines() if re.search('PASS|FAIL', line)]
    return dict(lines=found[-1:], ok=bool(found), nz=not found)


def parse_xctest_sum(suite, output, code, modules):
    """gate.sh's metal() awk: per-bundle Executed totals summed, after the first case_lines failing cases."""
    label, limit = suite['label'], suite.get('case_lines', 8)
    lines, shown, n, f, s, bundle = [], 0, 0, 0, 0, False
    for line in output.splitlines():
        if re.search(r'error: -\[', line) and shown < limit:
            lines.append(f"{label} case: {re.sub(r'^.*error: ', '', line)[:240]}")
            shown += 1
        if re.search(r'Test Suite .*\.xctest. (passed|failed)', line):
            bundle = True
            continue
        if bundle and re.search(r'Executed [0-9]+ tests?', line):
            n += int(re.search(r'Executed ([0-9]+)', line).group(1))
            failed = re.search(r'([0-9]+) failures?', line)
            if failed:
                f += int(failed.group(1))
            skipped = re.search(r'([0-9]+) tests? skipped', line)
            if skipped:
                s += int(skipped.group(1))
            bundle = False
    lines.append(f'{label}: FAIL no tests ran' if n == 0 else f'{label}: {n} tests, {f} failed')
    return dict(lines=lines, tests=n, failures=f, skipped=s)


def parse_unittest_modules(suite, output, code, modules):
    """agentd_gate.sh's summary over one unittest process per module."""
    ran = sum(sum(_numbers(r'(?m)^Ran ([0-9]+) tests?', text)) for _, _, text in modules)
    bad = [name for name, rc, _ in modules if rc != 0]
    text = ''.join(text for _, _, text in modules)
    lines = [suite['line'].format(tests=ran, modules=len(modules))]
    if bad or ran == 0:
        lines.append('failing: ' + ' '.join(bad))
    return dict(lines=lines, tests=ran, ok=not bad and ran > 0,
                failures=sum(_numbers(r'failures=([0-9]+)', text) + _numbers(r'errors=([0-9]+)', text)),
                skipped=sum(_numbers(r'skipped=([0-9]+)', text)))


def parse_checks(suite, output, code, modules):
    """The last '<label>: <n> checks, <m> failed' line after the first case_lines 'FAIL ' lines; without it, the
    output's tail (a failed build)."""
    label, lines = suite['label'], output.splitlines()
    found = [line for line in lines if re.fullmatch(rf'{re.escape(label)}: [0-9]+ checks, [0-9]+ failed', line)][-1:]
    if not found:
        return dict(lines=lines[-20:] + [f'{label}: FAIL no checks ran'], ok=False)
    checks, failed = map(int, re.findall(r'[0-9]+', found[0][len(label):]))
    cases = [line for line in lines if line.startswith('FAIL ')][:suite.get('case_lines', 8)]
    return dict(lines=cases + found, tests=checks, failures=failed, ok=checks > 0)


def _count(output, word, pattern):
    """web_gate.sh's count(): the number before <word> on the last line matching pattern, else 0."""
    last = [line for line in output.splitlines() if re.search(pattern, line)][-1:]
    found = re.search(rf'([0-9]+) {word}', last[0]) if last else None
    return int(found.group(1)) if found else 0


def _counted(suite, output, pattern):
    passed, failed = _count(output, 'passed', pattern), _count(output, 'failed', pattern)
    return dict(lines=[suite['line'].format(passed=passed, failed=failed)], tests=passed, failures=failed)


def parse_vitest_count(suite, output, code, modules):
    return _counted(suite, output, r'^ +Tests +[0-9]')


def parse_playwright_count(suite, output, code, modules):
    passed, failed = _count(output, 'passed', r'^ +[0-9]+ passed'), _count(output, 'failed', r'^ +[0-9]+ failed')
    return dict(lines=[suite['line'].format(passed=passed, failed=failed)], tests=passed, failures=failed)


def parse_host_link(suite, output, code, modules):
    lines = output.splitlines()
    return dict(lines=[line for line in lines if line.startswith('FAIL ')] + lines[-1:])


def parse_remote(suite, output, code, modules):
    """The host's result of the suite, from the JSON last line of HOST_RUNNER test."""
    try:
        done = {s['id']: s for s in json.loads(output.splitlines()[-1])['suites']}[suite['id']]
    except (IndexError, ValueError, KeyError, TypeError):
        return dict(lines=output.splitlines()[-20:] + [f'{suite["id"]}: FAIL no result from the Windows host'], ok=False)
    return dict(lines=done['lines'], tests=done['tests'], failures=done['failures'], skipped=done['skipped'],
                ok=done['status'] == 'PASS')


PARSERS = dict(exit=parse_exit, tail1=parse_tail1, last_passfail=parse_last_passfail,
               xctest_sum=parse_xctest_sum, checks=parse_checks,
               unittest_modules=parse_unittest_modules, vitest_count=parse_vitest_count,
               playwright_count=parse_playwright_count, host_link=parse_host_link, build=parse_build,
               remote=parse_remote)
# Parsers whose gate.sh step printed NZ after a non-zero exit; a suite's "nz" overrides this.
NZ_PARSERS = {'tail1', 'last_passfail', 'xctest_sum', 'host_link'}


def suites_files():
    return [SUITES_FILE] + ([PRIVATE_SUITES_FILE] if PRIVATE_SUITES_FILE.exists() else [])


def load_suites(path=SUITES_FILE, private=PRIVATE_SUITES_FILE):
    doc = json.loads(Path(path).read_text())
    if doc.get('schema') != SCHEMA:
        raise ValueError(f'{path}: schema is not {SCHEMA}')
    if Path(private).exists():
        extra = json.loads(Path(private).read_text())
        if extra.get('schema') != SCHEMA:
            raise ValueError(f'{private}: schema is not {SCHEMA}')
        for sid, suite in extra['suites'].items():
            if sid in doc['suites']:
                raise ValueError(f'{private}: suite {sid} is already in {path}')
            doc['suites'][sid] = suite
        for name, profile in extra['profiles'].items():
            if name not in doc['profiles']:
                raise ValueError(f'{private}: profile {name} is not in {path}')
            doc['profiles'][name]['phases'] += profile['phases']
    if FORBIDDEN_PORT in json.dumps(doc):
        raise ValueError(f'{path}: port {FORBIDDEN_PORT} is Companion\'s; gate suites may not use it')
    for sid, suite in doc['suites'].items():
        suite['id'] = sid
        if suite.get('parse') not in PARSERS:
            raise ValueError(f'{sid}: unknown parse {suite.get("parse")!r}')
        if not set(suite.get('needs', [])) <= NEEDS:
            raise ValueError(f'{sid}: unknown needs {suite["needs"]}')
        if not set(suite.get('requires', [])) <= set(doc['suites']):
            raise ValueError(f'{sid}: requires unknown suites {suite["requires"]}')
        if not set(suite.get('os', ['macos'])) <= SYSTEMS:
            raise ValueError(f'{sid}: unknown os {suite["os"]}')
        if suite.get('host') not in (None, 'win') or (suite.get('host') and 'windows' not in suite.get('os', [])):
            raise ValueError(f'{sid}: host may only be "win", for a suite whose os holds windows')
    for name, profile in doc['profiles'].items():
        seen = []
        for phase in profile['phases']:
            for lane in phase['lanes']:
                for item in lane:
                    block = item if isinstance(item, dict) else None
                    for sid in block['suites'] if block else [item]:
                        if sid not in doc['suites']:
                            raise ValueError(f'profile {name}: unknown suite {sid}')
                        if doc['suites'][sid].get('host') == 'win' and not name.startswith('win-'):
                            raise ValueError(f'profile {name}: {sid} runs on the Windows host, so only a win-* profile may run it')
                        locked = bool(LOCKED_NEEDS & set(doc['suites'][sid].get('needs', [])))
                        if locked and not (block and block['lock'] == 'gpu'):
                            raise ValueError(f'profile {name}: {sid} needs a window or the gpu, so it must sit in a gpu block')
                        if not locked and block and block['lock'] == 'gpu':
                            raise ValueError(f'profile {name}: {sid} needs no window or gpu, so it takes no gpu lock')
                        seen.append(sid)
        if len(seen) != len(set(seen)):
            raise ValueError(f'profile {name}: a suite appears twice')
        for sid in profile.get('overrides', {}):
            if sid not in seen:
                raise ValueError(f'profile {name}: override for {sid}, which it does not run')
    return doc


def _under(path, entries):
    """Entries ending in / are directories; the others are files."""
    return any(path == entry or (entry.endswith('/') and path.startswith(entry)) for entry in entries)


def select(doc, changed):
    """(ids of the suites the changed files reach, with what they require, None) or (None, why the full profile runs).

    Whole-tree suites and suites without paths are always reached."""
    if not changed:
        return None, 'no changed files'
    for path in changed:
        if _under(path, doc.get('full_on', [])):
            return None, f'{path} changes the gate'
    suites = doc['suites']
    picked = {sid for sid, suite in suites.items() if 'paths' not in suite or '.' in suite['paths']}
    for path in changed:
        hit = {sid for sid, suite in suites.items() if _under(path, suite.get('paths', []))}
        if not hit and not _under(path, doc.get('no_suite', [])):
            return None, f"{path} is in no suite's paths"
        picked |= hit
    todo = list(picked)
    while todo:
        for need in suites[todo.pop()].get('requires', []):
            if need not in picked:
                picked.add(need)
                todo.append(need)
    return picked, None


def private_changes(repo, doc, base):
    """The files under the suite paths whose top directory git ignores, modified after base's commit time;
    UNHASHED_DIRS are skipped as blobs skips them."""
    since = int(git(repo, 'show', '-s', '--format=%ct', base))
    paths = {path for suite in doc['suites'].values() for path in suite.get('paths', [])}
    # check-ignore refuses a path beyond a symbolic link, and a worktree's ignored top directory is one.
    tops = sorted({path.split('/', 1)[0] for path in paths})
    ignored = set(subprocess.run(['git', '-C', str(repo), 'check-ignore', '--no-index', '--stdin'], input='\n'.join(tops),
                                 capture_output=True, text=True).stdout.split())
    entries = sorted(path for path in paths if path.split('/', 1)[0] in ignored)
    found = set()
    for entry in entries:
        root = Path(repo, entry)
        if root.is_file() and root.stat().st_mtime > since:
            found.add(entry)
        for directory, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in UNHASHED_DIRS]
            for name in filenames:
                path = Path(directory, name)
                if name != '.DS_Store' and path.is_file() and path.stat().st_mtime > since:
                    found.add(path.relative_to(repo).as_posix())
    return found


def fill(text, ctx):
    for key, value in ctx.items():
        text = text.replace('{' + key + '}', str(value))
    return text


def command(suite, ctx):
    argv = [fill(arg, ctx) for arg in suite['run']]
    return ['nice', '-n', '10', *argv] if suite.get('nice') else argv


def delegated(suite):
    """A host: win suite outside Windows becomes a run of HOST_RUNNER test on the host."""
    if suite.get('host') != 'win' or os.name == 'nt':
        return suite
    rest = {key: value for key, value in suite.items() if key not in ('modules', 'cwd', 'env', 'nice', 'line')}
    return dict(rest, run=[sys.executable, '-I', '{repo}/' + HOST_RUNNER, 'test', '--checkout', '{repo}',
                           suite['id']], parse='remote')


def run_command(argv, cwd, env, log, timeout):
    """(exit code, output); a timeout kills the process group and returns 124."""
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, 'wb') as stream:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 124
    return code, log.read_text(errors='replace')


def module_names(suite, ctx):
    """[(log name, directory, module file)] for a suite that runs one unittest process per module."""
    spec, found = suite['modules'], []
    for relative in spec['dirs']:
        directory = Path(ctx['repo']) / relative
        for path in sorted(directory.glob('*.py')):
            if any(fnmatch.fnmatch(path.name, p) for p in spec['patterns']):
                name = path.name if len(spec['dirs']) == 1 else f'{directory.name}/{path.name}'
                found.append((name, directory, path.name))
    return found


def suite_environ():
    """os.environ without the release profile: it picks the fingerprint only, and suites test the checkout's own profile."""
    return {k: v for k, v in os.environ.items() if k != release.PROFILE_ENV}


def run_suite(suite, ctx):
    start = time.time()
    logs = Path(ctx['logs'])
    env = dict(suite_environ(), AGENTD_PYTHON=ctx['agentd_python'])
    env.update({key: fill(value, ctx) for key, value in suite.get('env', {}).items()})
    timeout, modules = suite.get('timeout', SUITE_TIMEOUT), None
    if 'modules' in suite:
        def one(entry):
            name, directory, module = entry
            code, text = run_command(command(suite, dict(ctx, module=module)), directory, env,
                                     logs / suite['id'] / f'{name}.log', timeout)
            return name, code, text
        with ThreadPoolExecutor(int(ctx['jobs'])) as pool:
            modules = list(pool.map(one, module_names(suite, ctx)))
        code, output, log = max([rc for _, rc, _ in modules], default=0), '', f'{suite["id"]}/'
    else:
        log = f'{suite["id"]}.log'
        code, output = run_command(command(suite, ctx), Path(ctx['repo']) / fill(suite.get('cwd', '.'), ctx), env,
                                   logs / log, timeout)
    result = evaluate(suite, output, code, modules)
    if code == 124 and timeout:
        result.lines.append(f'{suite["id"]}: FAIL timed out after {timeout} s')
        result.status = 'FAIL'
    result.seconds, result.log = round(time.time() - start, 1), log
    return result


def evaluate(suite, output, code, modules=None):
    parsed = PARSERS[suite['parse']](suite, output, code, modules)
    lines = list(parsed['lines'])
    tests, skipped = parsed.get('tests'), parsed.get('skipped')
    if skipped is not None and skipped > suite.get('max_skipped', skipped):
        lines[-1] += f', {skipped} skipped > max {suite["max_skipped"]}'
    passed = lambda: (code == 0 and parsed.get('ok', True) and not any(VERDICT.search(line) for line in lines)
                      and (tests or 0) >= suite.get('min_tests', 0)
                      and (skipped or 0) <= suite.get('max_skipped', skipped or 0))
    # nz: true appends NZ after a non-zero exit or the parser's nz; "exit" puts it first, on a non-zero exit only;
    # "fail" appends it whenever the suite fails.
    mode = suite.get('nz', suite['parse'] in NZ_PARSERS)
    if mode == 'exit' and code != 0:
        lines.insert(0, NZ)
    elif (mode == 'fail' and not passed()) or (mode is True and (code != 0 or parsed.get('nz'))):
        lines.append(NZ)
    return SuiteResult(suite['id'], lines, 'PASS' if passed() else 'FAIL', code, tests, parsed.get('failures'), skipped)


def run_block(block, suites, ctx):
    """Runs the suites of a lock block in a child gate.py under tools/platform/gpu-lock.sh; one lock implementation."""
    logs = Path(ctx['logs'])
    label = fill(block['label'], ctx)
    slug = re.sub(r'[^A-Za-z0-9_.-]', '_', label)
    spec, out = logs / f'block-{slug}.json', logs / f'block-{slug}.results.json'
    out.unlink(missing_ok=True)
    spec.write_text(json.dumps(dict(suites=suites, ctx=ctx, lock=block['lock'],
                                    stop_on_nz=block.get('stop_on_nz', False), out=str(out))))
    argv = [str(Path(ctx['repo']) / 'tools/platform/gpu-lock.sh'), label, sys.executable, '-I', str(Path(__file__).resolve()),
            '--exec-block', str(spec)]
    code, _ = run_command(argv, ctx['repo'], dict(os.environ, AAC_LOCK=block['lock']), logs / f'block-{slug}.log', None)
    done = [SuiteResult(**r) for r in json.loads(out.read_text())] if code == 0 and out.exists() else []
    ran = {r.id for r in done}
    for suite in suites:
        if suite['id'] not in ran and not (block.get('stop_on_nz') and any(NZ in r.lines for r in done)):
            done.append(SuiteResult(suite['id'], [NZ], 'FAIL', code, lock=block['lock']))
    return done


def exec_block(spec_path):
    spec = json.loads(Path(spec_path).read_text())
    results = []
    for suite in spec['suites']:
        result = run_suite(suite, spec['ctx'])
        result.lock = spec['lock']
        results.append(result)
        # As the scripts' `a && b`: stop after a suite whose step exited non-zero, that is printed NZ.
        if spec['stop_on_nz'] and NZ in result.lines:
            break
    Path(spec['out']).write_text(json.dumps([dataclasses.asdict(r) for r in results]))
    return 0


def plan(doc, profile_name, perf, only, only_reason='not in --only'):
    """The profile's phases of lanes of items: ('suite', suite), ('block', block, [suite]) or ('skip', suite, reason, [id])."""
    profile = doc['profiles'][profile_name]
    perf = perf or profile.get('perf', False)
    overrides = profile.get('overrides', {})
    resolve = lambda sid: delegated(dict(doc['suites'][sid], **overrides.get(sid, {})))

    def item(suite):
        if only is not None and suite['id'] not in only:
            return ('skip', suite, only_reason, [suite['id']])
        if suite.get('perf_only') and not perf:
            return ('skip', suite, 'no --perf', [suite['id']])
        return ('suite', suite)

    phases = []
    for phase in profile['phases']:
        lanes = []
        for lane in phase['lanes']:
            items = []
            for entry in lane:
                if isinstance(entry, dict):
                    inner = [item(resolve(sid)) for sid in entry['suites']]
                    run = [i[1] for i in inner if i[0] == 'suite']
                    items += [('block', entry, run)] if run else []
                    items += [i for i in inner if i[0] == 'skip']
                else:
                    items.append(item(resolve(entry)))
            lanes.append(items)
        phases.append(lanes)
    return phases


def run_lane(items, ctx, hits):
    """[(item, [SuiteResult])]; a suite in hits takes that result without running; a failed fatal suite skips the rest
    of its lane."""
    done, stopped = [], None
    for entry in items:
        if entry[0] == 'skip':
            done.append((entry, []))
        elif stopped:
            names = [entry[1]['id']] if entry[0] == 'suite' else [s['id'] for s in entry[2]]
            done.append((('skip', entry[1] if entry[0] == 'suite' else None, f'after fatal {stopped}', names), []))
        elif entry[0] == 'suite':
            result = hits.get(entry[1]['id']) or run_suite(entry[1], ctx)
            done.append((entry, [result]))
            if result.status == 'FAIL' and entry[1].get('fatal'):
                stopped = entry[1]['id']
        else:
            done.append((entry, run_block(entry[1], entry[2], ctx)))
    return done


def run_profile(phases, ctx, nz_phases=(), hits=None):
    """(lines, results, skipped suites, passed, seconds per phase); a phase whose index is in nz_phases ends with NZ if
    one of its suites failed. hits: {suite id: SuiteResult} reused in place of running the suite."""
    outcome, abort, phase_seconds = [], None, []
    for index, lanes in enumerate(phases):
        if abort:
            for items in lanes:
                for entry in items:
                    names = [entry[1]['id']] if entry[0] != 'block' else [s['id'] for s in entry[2]]
                    outcome.append((('skip', None, f'after fatal {abort.id}', names), []))
            phase_seconds.append(0.0)
            continue
        start, begun = len(outcome), time.monotonic()
        with ThreadPoolExecutor(max(1, len(lanes))) as pool:
            for done in pool.map(lambda items: run_lane(items, ctx, hits or {}), lanes):
                outcome += done
        phase_seconds.append(round(time.monotonic() - begun, 1))
        if index in nz_phases and any(r.status == 'FAIL' for _, done in outcome[start:] for r in done):
            outcome.append((('line', NZ), []))
        for entry, results in outcome:
            for result in results:
                if result.status == 'FAIL' and entry[0] == 'suite' and entry[1].get('fatal') == 'gate':
                    abort = abort or result
    chunks, results, skipped = [], [], []  # chunks: (suite id or None, lines)
    for entry, done in outcome:
        if entry[0] == 'line':
            chunks.append((None, [entry[1]]))
        elif entry[0] == 'skip':
            skipped += [dict(id=sid, reason=entry[2]) for sid in entry[3]]
            if entry[2] == 'no --perf' and entry[1].get('skip_line'):
                # skip_line_before: the suite whose lines the skip line precedes; else it follows the lines so far.
                at = [i for i, (sid, _) in enumerate(chunks) if sid == entry[1].get('skip_line_before')]
                chunks.insert(at[0] if at else len(chunks), (None, [entry[1]['skip_line']]))
        results += done
        chunks += [(result.id, result.lines) for result in done]
    lines = [line for _, chunk in chunks for line in chunk]
    if abort:
        lines = list(abort.lines)
    return lines, results, skipped, verdict(results), phase_seconds


def verdict(results):
    return all(result.status == 'PASS' for result in results)


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True).stdout.strip()


def first_line(argv):
    try:
        return (subprocess.run(argv, capture_output=True, text=True, timeout=60).stdout.strip().splitlines() or ['none'])[0]
    except (OSError, subprocess.TimeoutExpired):
        return 'none'


def sha256(*paths):
    result = hashlib.sha256()
    for path in paths:
        result.update(Path(path).read_bytes())
    return result.hexdigest()


def utc(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def toolchain():
    return dict(python=platform.python_version(), node=first_line(['node', '--version']),
                swift=first_line(['swift', '--version']))


def cache_dir(repo):
    """<main checkout>/.local/cache/gate-results: the main checkout and its worktrees share one cache."""
    common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    return (Path(common).parent if common else Path(repo)) / '.local/cache/gate-results'


@contextlib.contextmanager
def checkout_lock(repo, profile):
    """Holds the gate runner's checkout lock of repo's main checkout (gate_daemon.py) and prints GATE QUEUE once while
    another run holds it; a run the holder started takes none. Yields the seconds it queued."""
    if os.name == 'nt':
        # gate_daemon.alive's os.kill(pid, 0) would terminate the holder there.
        yield 0.0
        return
    spec = importlib.util.spec_from_file_location('gate_daemon', HERE / 'gate_daemon.py')
    daemon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(daemon)
    if os.environ.get(daemon.LOCK_HELD):
        yield 0.0
        return
    common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    root = Path(common).parent if common else repo
    lock = daemon.Daemon(root).checkout_lock
    # A runner from before LOCK_HELD calls gate.py while it holds the lock; waiting on the parent would never end.
    if daemon.lock_pid(lock) == os.getppid():
        yield 0.0
        return
    label = f'gate {profile} {repo.relative_to(root) if repo.is_relative_to(root) else repo}'
    queued = 0.0
    if not daemon.acquire(lock, label, wait=False):
        print(f'GATE QUEUE: waiting for {daemon.owner(lock)}', flush=True)
        queued = time.monotonic()
        # The runner holds the lock one step at a time and goes after the runs that left a file here.
        mine = daemon.waiters(lock) / str(os.getpid())
        mine.parent.mkdir(parents=True, exist_ok=True)
        mine.touch()
        try:
            daemon.acquire(lock, label)
        finally:
            mine.unlink(missing_ok=True)
        queued = time.monotonic() - queued
    with daemon.held(lock, label):
        yield queued


def blobs(repo, entries):
    """{path: id} of the existing tracked and untracked, not ignored, files under entries: their git blob id.

    An entry git lists nothing under (a directory git ignores) gives the sha256 of each file under it outside
    UNHASHED_DIRS instead."""
    listed = subprocess.run(['git', '-C', str(repo), 'ls-files', '-z', '-c', '-o', '--exclude-standard', '--', *entries],
                            capture_output=True, check=True).stdout.decode().split('\0')
    paths = sorted({path for path in listed if path and _under(path, entries) and Path(repo, path).is_file()})
    ids = subprocess.run(['git', '-C', str(repo), 'hash-object', '--stdin-paths'], input=''.join(p + '\n' for p in paths),
                         capture_output=True, text=True, check=True).stdout.split()
    found = dict(zip(paths, ids))
    for entry in entries:
        if any(_under(path, [entry]) for path in paths):
            continue
        root = Path(repo, entry)
        if root.is_file():
            found[entry] = source_fingerprint.digest(root)
        for directory, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in UNHASHED_DIRS]
            for name in filenames:
                path = Path(directory, name)
                if name != '.DS_Store' and path.is_file():
                    found[path.relative_to(repo).as_posix()] = source_fingerprint.digest(path)
    return dict(sorted(found.items()))


def cache_keys(doc, phases, repo, ctx, tools):
    """{suite id: key} of the suites to run whose PASS may be reused: with paths, outside lock blocks, not fatal and
    not run on the Windows host.

    A key covers the resolved suite, the gate's own files, the toolchain, the AAC_* and AGENTD_PYTHON
    environment, the files under the suite's paths and the key of each suite it requires, transitively."""
    suites = [e[1] for lanes in phases for items in lanes for e in items
              if e[0] == 'suite' and e[1].get('paths') and not e[1].get('fatal') and not e[1].get('host')]
    if not suites:
        return {}
    resolved = {s['id']: s for lanes in phases for items in lanes for e in items
                for s in (e[2] if e[0] == 'block' else [e[1]])}
    needed, todo = {}, list(suites)
    while todo:
        suite = todo.pop()
        if suite['id'] not in needed:
            needed[suite['id']] = suite
            todo += [resolved.get(sid, doc['suites'][sid]) for sid in suite.get('requires', [])]
    files = blobs(repo, sorted({path for suite in needed.values() for path in suite.get('paths', []) if path != '.'}))
    # "." adds the working-tree bytes of every tracked file, including paths outside any component.
    tracked = {}
    if any('.' in suite.get('paths', []) for suite in needed.values()):
        names = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z']).decode().split('\0')
        for name in filter(None, names):
            path = Path(repo, name)
            tracked[name] = source_fingerprint.digest(path) if path.is_file() else None
    # The interpreter, not its path: each checkout's agent/.venv path differs, and a path would keep checkouts apart.
    env = dict(suite_environ(), AGENTD_PYTHON=os.path.realpath(ctx['agentd_python']))
    common = dict(gate=sorted(blobs(repo, doc.get('full_on', [])).items()), tools=tools,
                  runner=sha256(*suites_files(), Path(__file__).resolve(), Path(source_fingerprint.__file__),
                                Path(gate_receipt.__file__)),
                  env=sorted((k, v) for k, v in env.items() if k.startswith('AAC_') or k == 'AGENTD_PYTHON'))
    own = {sid: hashlib.sha256(json.dumps(dict(
                common, suite=suite, tracked=tracked if '.' in suite.get('paths', []) else None,
                files=[[p, b] for p, b in files.items() if _under(p, suite.get('paths', []))]),
                sort_keys=True).encode()).hexdigest()
           for sid, suite in needed.items()}

    def key(sid):
        return hashlib.sha256(json.dumps([own[sid], [key(need) for need in sorted(needed[sid].get('requires', []))]])
                              .encode()).hexdigest()
    return {suite['id']: key(suite['id']) for suite in suites}


def cache_hits(phases, keys, folder):
    """{suite id: SuiteResult} of the stored results to reuse; a suite that another suite to run requires runs too."""
    stored = {sid: json.loads(path.read_text()) for sid, key in keys.items()
              if (path := folder / sid / f'{key}.json').exists()}
    planned = [s for lanes in phases for items in lanes for e in items if e[0] != 'skip'
               for s in ([e[1]] if e[0] == 'suite' else e[2])]
    while needed := {need for s in planned if s['id'] not in stored for need in s.get('requires', [])} & set(stored):
        for sid in needed:
            del stored[sid]
    return {sid: SuiteResult(sid, entry['lines'], 'PASS', 0, entry['tests'], entry['failures'], entry['skipped'],
                             cached=dict(key=keys[sid], from_checkout=entry['checkout'],
                                         from_started_at=entry['started_at'], seconds=entry['seconds']))
            for sid, entry in stored.items()}


def store_results(results, keys, folder, origin, store=True):
    """Deletes the stored PASS of each suite that failed under its key; with store, stores each PASS that ran.

    origin: the checkout, started_at, head and profile of this run."""
    for result in results:
        if result.status != 'PASS' and result.id in keys:
            (folder / result.id / f'{keys[result.id]}.json').unlink(missing_ok=True)
        if store and result.status == 'PASS' and result.id in keys and not result.cached:
            path = folder / result.id / f'{keys[result.id]}.json'
            path.parent.mkdir(parents=True, exist_ok=True)
            # Other worktrees read the same folder; a reader sees the old file or the whole new one.
            partial = path.with_suffix(f'.{os.getpid()}.tmp')
            partial.write_text(json.dumps(dict(dataclasses.asdict(result), **origin), indent=1) + '\n')
            os.replace(partial, path)
            for old in path.parent.glob('*.json'):
                if time.time() - old.stat().st_mtime > CACHE_DAYS * 86400:
                    old.unlink(missing_ok=True)


def print_plan(phases, ctx, hits):
    for p, lanes in enumerate(phases, 1):
        for l, items in enumerate(lanes, 1):
            print(f'phase {p} lane {l}:')
            for entry in items:
                if entry[0] == 'skip':
                    print(f'  {entry[1]["id"]}: skipped ({entry[2]})')
                elif entry[0] == 'suite':
                    mark = '(cached) ' if entry[1]['id'] in hits else ''
                    print(f'  {entry[1]["id"]}: {mark}{" ".join(command(entry[1], ctx))}')
                else:
                    print(f'  lock {entry[1]["lock"]} as {fill(entry[1]["label"], ctx)}:')
                    for suite in entry[2]:
                        print(f'    {suite["id"]}: {" ".join(command(suite, ctx))}')


def main(argv=None):
    clock = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--profile')
    parser.add_argument('--checkout', type=Path, default=RUNNER_ROOT)
    parser.add_argument('--logs', type=Path)
    parser.add_argument('--perf', action='store_true')
    parser.add_argument('--jobs', type=int, default=6)
    parser.add_argument('--only')
    parser.add_argument('--changed', metavar='BASE')
    parser.add_argument('--no-cache', action='store_true', help='read no stored suite result (still store new ones)')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--exec-block', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.exec_block:
        return exec_block(args.exec_block)
    if args.list:
        doc = load_suites()
        for name, profile in doc['profiles'].items():
            ids = [s['id'] for lanes in plan(doc, name, True, None) for items in lanes for e in items
                   for s in ([e[1]] if e[0] != 'block' else e[2])]
            print(f'{name}: {" ".join(ids)}')
        return 0
    if args.only and args.changed:
        parser.error('--only and --changed exclude each other')
    repo = args.checkout.resolve()
    # The plan and the cache keys read the sources the run tests, so they wait for the lock with it.
    with contextlib.nullcontext(0.0) if args.dry_run else checkout_lock(repo, args.profile) as queued:
        doc = load_suites()
        if args.profile not in doc['profiles']:
            parser.error(f'--profile must be one of {", ".join(doc["profiles"])}')
        only = set(args.only.split(',')) if args.only else None
        selection = None
        if args.changed:
            if subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', '-q', f'{args.changed}^{{commit}}'],
                              capture_output=True).returncode:
                parser.error(f'--changed: {args.changed} is not a commit in {repo}')
            changed_files = sorted({path for listing in (git(repo, 'diff', '--name-only', f'{args.changed}...HEAD'),
                                                         git(repo, 'diff', '--name-only', 'HEAD'),
                                                         git(repo, 'ls-files', '--others', '--exclude-standard'))
                                    for path in listing.splitlines() if path}
                                   | private_changes(repo, doc, args.changed))
            only, full = select(doc, changed_files)
            if not changed_files and doc['profiles'][args.profile].get('empty_changes') == 'none':
                only, full = set(), None
            selection = dict(base=args.changed, changed=changed_files[:200], full=full)
        phases = plan(doc, args.profile, args.perf, only, 'not reached by the changes' if args.changed else 'not in --only')
        known = {e[1]['id'] for lanes in phases for items in lanes for e in items if e[0] != 'block'}
        known |= {s['id'] for lanes in phases for items in lanes for e in items if e[0] == 'block' for s in e[2]}
        if args.only and only - known:
            parser.error(f'--only names suites not in {args.profile}: {", ".join(sorted(only - known))}')
        head = []
        if selection:
            head = [f'SELECT: full profile, {selection["full"]}' if selection['full'] else
                    f'SELECT: {len(only & known)} of {len(known)} suites for {len(changed_files)} changed files since {args.changed}']
        keep = args.logs is not None
        logs = args.logs.resolve() if keep else Path(tempfile.mkdtemp(prefix='host-gate.'))
        logs.mkdir(parents=True, exist_ok=True)
        # As agentd-python.sh does first; Windows has no bash to run it.
        agentd_python = os.environ.get('AGENTD_PYTHON') or subprocess.run(
            ['bash', str(RUNNER_ROOT / 'tools/platform/agentd-python.sh')], capture_output=True, text=True, check=True).stdout.strip()
        ctx = dict(repo=str(repo), logs=str(logs), agentd_python=agentd_python,
                   jobs=args.jobs, name=repo.name, runner=str(Path(__file__).resolve()))
        tools = toolchain()
        keys, folder = cache_keys(doc, phases, repo, ctx, tools), cache_dir(repo)
        hits = {} if args.no_cache else cache_hits(phases, keys, folder)
        if hits:
            planned = [s for lanes in phases for items in lanes for e in items if e[0] != 'skip'
                       for s in ([e[1]] if e[0] == 'suite' else e[2])]
            head.append(f'CACHE: {len(hits)} of {len(planned)} suites reused')
        if args.dry_run:
            for line in head:
                print(line)
            print_plan(phases, ctx, hits)
            if not keep:
                shutil.rmtree(logs)
            return 0
        started = datetime.datetime.now(datetime.timezone.utc)
        files, f0 = source_fingerprint.compute(repo)
        guard = release.source_state(repo)
        changed = set(git(repo, 'diff', '--name-only', 'HEAD').splitlines()) | set(
            git(repo, 'ls-files', '--others', '--exclude-standard').splitlines())
        nz_phases = {i for i, phase in enumerate(doc['profiles'][args.profile]['phases']) if phase.get('nz')}
        setup_s = round(time.monotonic() - clock - queued, 1)
        lines, results, skipped, passed, phases_s = run_profile(phases, ctx, nz_phases, hits)
        ended = time.monotonic()
        lines = head + lines
        f1 = source_fingerprint.compute(repo)[1]
        # The keys also cover test inputs outside the shipping fingerprint.
        same = f1 == f0 and cache_keys(doc, phases, repo, ctx, tools) == keys
        if not same:
            lines.append('SOURCES-CHANGED FAIL')
        store_results(results, keys, folder,
                      dict(checkout=str(repo), started_at=utc(started), head=guard['head'], profile=args.profile), same)
        passed = passed and same
        finished = datetime.datetime.now(datetime.timezone.utc)
        receipt = gate_receipt.build(
            profile=args.profile, result='PASS' if passed else 'FAIL', partial=only is not None,
            started_at=utc(started), finished_at=utc(finished), duration_s=round((finished - started).total_seconds(), 1),
            checkout=str(repo), head=guard['head'], main=guard['main'], branch=git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
            source=dict(algorithm='endfield-release-source/v1', fingerprint=f0, files=len(files), changed_during_run=f1 != f0),
            shipping_sources_clean=guard['shipping_sources_clean'], dirty_shipping=guard['dirty_shipping'],
            dirty_other=sorted(changed - set(guard['dirty_shipping']))[:50],
            suites_sha256=sha256(*suites_files()),
            runner_sha256=gate_receipt.runner_digest(RUNNER_ROOT, repo),
            host=dict(tools, macos=platform.mac_ver()[0]),
            logs_kept=keep, suites=[dataclasses.asdict(r) for r in results], skipped_suites=skipped, selection=selection,
            cache=dict(enabled=not args.no_cache, reused=[r.id for r in results if r.cached]),
            timing=dict(queue_s=round(queued, 1), setup_s=setup_s, phases_s=phases_s, teardown_s=round(time.monotonic() - ended, 1)))
        stored = gate_receipt.write(receipt, logs if keep else None, gate_receipt.store_dir(repo))
        if not keep:
            shutil.rmtree(logs)
        for line in lines:
            print(line)
        print(f'receipt: {logs / gate_receipt.LATEST if keep else stored}')
        print('GATE PASS' if passed else 'GATE FAIL')
        return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
