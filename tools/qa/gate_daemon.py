#!/usr/bin/env python3
"""The one gate runner: verifies each new main commit in its own checkout and keeps refs/endfield/green.

Usage: gate_daemon.py ensure | serve | status [--json] | link <worktree> | pack [--profile FILE] | release [--sha SHA] [--profile FILE]
link    gives a session's worktree the runner's links to the main checkout's ignored inputs and a cloned agent/.venv;
        it and each runner checkout sync that venv to the checkout's hashed Python locks with uv when they change.
ensure  starts serve in the background unless it runs; serve runs from the runner checkout, not the caller's tree.
serve   every 30 s: a new refs/heads/main runs `gate.py --profile commit` in <root>/.claude/worktrees/gr; PASS moves
        refs/endfield/green; FAIL reruns once on the same commit (a second PASS is recorded as flaky), and a second
        FAIL bisects the first-parent commits since green with --only <red suites and what they require>. Idle, it
        runs --no-cache on green once a day. Receipts go to the main checkout's .local/gate-receipts.
pack    builds the gated release of main in <root>/.claude/worktrees/pk; release.py builds it only with a PASS commit
        or release receipt for main.
        --profile <file> builds with that release profile (AAC_RELEASE_PROFILE, which the fingerprint, the dirty check,
        the receipts and packaging read); without a PASS receipt of its fingerprint, it runs `gate.py --profile commit`
        on main in the runner checkout first (FAIL reruns once) and builds only when that passes.
release runs `gate.py --profile release` on main (or --sha) in the runner checkout; only to publish or close a phase.
        FAIL reruns once on the same commit (a second PASS is recorded as flaky). --profile as for pack.
State lives in <root>/.local/gate-daemon/ (status.json, events.jsonl, daemon.log, logs/). Stdlib only.
"""
import argparse
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/release'))
import gate_receipt  # noqa: E402
from release import PROFILE_ENV, default_profile  # noqa: E402
import source_fingerprint  # noqa: E402

POLL_S = 30
WAIT_POLL_S = 5
FULL_EVERY = datetime.timedelta(hours=24)
KEEP_LOGS = 10
GREEN = 'refs/endfield/green'
MAIN = 'refs/heads/main'
# Inputs a checkout takes from the main checkout; the release profile's catalog, ui_art and photo_looks add the
# directories they name.
LINKS = ['.local/inputs', '.local/cache/character-system',
         '.local/cache/personal-agent-runtime', '.local/gate-receipts', '.local/pi-runtime']
# release.py in any checkout looks for receipts here; the runner's receipts must land in the main checkout's store.
RECEIPTS = '.local/gate-receipts'
# Set for the gate.py runs of a holder of the checkout lock, so that gate.py does not wait on it. Not AAC_*: those
# enter the suites' cache keys, and the runner's results must stay reusable by session gates.
LOCK_HELD = 'GATE_CHECKOUT_LOCK_HELD'
# The hashed Python locks agentd's suites import from (tools/release/harness_runtime.py PYTHON_LOCKS).
VENV_LOCKS = ['agent/agentd/requirements-character-agent.lock', 'app/packaging/requirements-content.lock']
# In a checkout's agent/.venv: the sha256 of the VENV_LOCKS contents it was last synced to.
VENV_STAMP = '.gate-locks'


def utc(moment=None):
    return (moment or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_utc(text):
    return datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def rev(cwd, ref):
    out = subprocess.run(['git', '-C', str(cwd), 'rev-parse', '--verify', '-q', f'{ref}^{{commit}}'],
                         capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else None


def main_root():
    here = Path(__file__).resolve().parent
    common = subprocess.run(['git', '-C', str(here), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                            capture_output=True, text=True).stdout.strip()
    return Path(common).parent if common else here.parents[1]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def lock_pid(lock):
    try:
        return int((Path(lock) / 'pid').read_text().strip())
    except (OSError, ValueError):
        return None


def acquire(lock, label, wait=True):
    """Takes the mkdir lock as tools/platform/gpu-lock.sh does; a dead pid is reclaimed, our own pid (after execv) kept."""
    lock = Path(lock)
    lock.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            pid = lock_pid(lock)
            if pid == os.getpid():
                break
            if pid is not None and not alive(pid):
                shutil.rmtree(lock, ignore_errors=True)
                continue
            # Without a pid a lock younger than 30 s may be one whose holder is still writing it.
            try:
                stale = pid is None and time.time() - lock.stat().st_mtime > 30
            except FileNotFoundError:
                continue
            if stale:
                shutil.rmtree(lock, ignore_errors=True)
                continue
            if not wait:
                return False
            time.sleep(5)
    (lock / 'pid').write_text(f'{os.getpid()}\n')
    (lock / 'owner').write_text(f'{label} {utc()}\n')
    return True


@contextlib.contextmanager
def held(lock, label):
    acquire(lock, label)
    try:
        yield
    finally:
        shutil.rmtree(lock, ignore_errors=True)


def waiters(lock):
    """The directory where a gate.py run waiting on lock leaves a file named by its pid."""
    return Path(f'{lock}.wait')


def yield_to_waiters(lock):
    """Returns once no live gate.py run waits on lock; files of dead pids are removed."""
    while True:
        live = False
        for entry in waiters(lock).glob('*'):
            if entry.name.isdigit() and alive(int(entry.name)):
                live = True
            else:
                entry.unlink(missing_ok=True)
        if not live:
            return
        time.sleep(WAIT_POLL_S)


@contextlib.contextmanager
def step(lock, label):
    """The runner holds lock for one checkout and gate run at a time, after the waiting sessions' runs."""
    yield_to_waiters(lock)
    with held(lock, label):
        yield


def owner(lock):
    try:
        return (Path(lock) / 'owner').read_text().strip()
    except OSError:
        return None


def notify(title, text):
    subprocess.run(['osascript', '-e', 'on run argv', '-e',
                    'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text],
                   capture_output=True)


def with_requires(checkout, suites):
    """suites plus what they require in the checkout's tools/qa/suites.json and private/suites.json (gate.load_suites
    merges both); --only does not add those itself."""
    defined = {}
    for name in ('tools/qa/suites.json', 'private/suites.json'):
        path = Path(checkout) / name
        if path.is_file():
            defined.update(json.loads(path.read_text())['suites'])
    picked, todo = list(suites), list(suites)
    while todo:
        for need in defined.get(todo.pop(), {}).get('requires', []):
            if need not in picked:
                picked.append(need)
                todo.append(need)
    return picked


def prune(logs):
    dirs = sorted((p for p in Path(logs).iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime)
    for old in dirs[:-KEEP_LOGS]:
        shutil.rmtree(old, ignore_errors=True)


class Daemon:
    def __init__(self, root):
        self.root = Path(root)
        self.state = self.root / '.local/gate-daemon'
        self.logs = self.state / 'logs'
        self.gr = self.root / '.claude/worktrees/gr'
        self.pk = self.root / '.claude/worktrees/pk'
        cache = self.root / '.local/cache'
        self.daemon_lock = cache / 'gate-daemon.lock'
        self.checkout_lock = cache / 'gate-checkout.lock'
        self.pack_lock = cache / 'pack.lock'
        self.self_hash = sha256(__file__)

    def load(self):
        path = self.state / 'status.json'
        return json.loads(path.read_text()) if path.is_file() else {}

    def update(self, **fields):
        status = self.load()
        status.update(fields)
        self.state.mkdir(parents=True, exist_ok=True)
        tmp = self.state / f'.status.{os.getpid()}.tmp'
        tmp.write_text(json.dumps(status, indent=1) + '\n')
        os.replace(tmp, self.state / 'status.json')
        return status

    def event(self, kind, **fields):
        self.state.mkdir(parents=True, exist_ok=True)
        line = json.dumps(dict(at=utc(), event=kind, **fields))
        with open(self.state / 'events.jsonl', 'a') as f:
            f.write(line + '\n')
        print(line, flush=True)

    def prepare(self, checkout):
        if not checkout.exists():
            checkout.parent.mkdir(parents=True, exist_ok=True)
            git(self.root, 'worktree', 'add', '--detach', str(checkout), MAIN)
        # tools/platform/agentd-python.sh takes <checkout>/agent/.venv/bin/python for the checkout's suites.
        if not os.path.lexists(checkout / 'agent/.venv'):
            (checkout / 'agent').mkdir(parents=True, exist_ok=True)
            subprocess.run(['cp', '-c', '-R', str(self.root / 'agent/.venv'), str(checkout / 'agent/.venv')], check=True)

    def checkout(self, checkout, sha):
        self.prepare(checkout)
        git(checkout, 'checkout', '-q', '--force', '--detach', sha)
        git(checkout, 'clean', '-fd')
        self.sync_venv(checkout)
        self.link(checkout)

    def sync_venv(self, checkout):
        """Installs the checkout's hashed Python locks into its agent/.venv when they differ from the last sync."""
        locks = [checkout / name for name in VENV_LOCKS]
        key = hashlib.sha256(b''.join(path.read_bytes() for path in locks)).hexdigest()
        stamp = checkout / 'agent/.venv' / VENV_STAMP
        if stamp.is_file() and stamp.read_text() == key:
            return
        subprocess.run(['uv', 'pip', 'install', '--python', str(checkout / 'agent/.venv/bin/python'), '--require-hashes',
                        '--only-binary=:all:', *[arg for path in locks for arg in ('-r', str(path))]], check=True)
        stamp.write_text(key)

    def link(self, checkout):
        """Links the git-ignored inputs the gates and packaging read from the main checkout into checkout."""
        checkout = Path(checkout)
        names = list(LINKS)
        private = checkout / 'private'
        if (self.root / 'private').is_dir() and not private.is_symlink():
            # A checkout made while that directory was tracked keeps only its ignored build output there; replace it.
            if private.exists() and not git(checkout, 'ls-files', 'private'):
                shutil.rmtree(private)
            if not private.exists():
                private.symlink_to(self.root / 'private')
        # Read after the link: the local profile is private/release/release.json.
        profile = json.loads(default_profile(checkout).read_text())
        for path in [profile['character_catalog'], profile.get('ui_art'), profile.get('photo_looks')]:
            # A build output's whole .local/output/<name>, else its top directory (.local/library).
            if path: names.append(str(Path(*Path(path).parts[:3 if Path(path).parts[1] == 'output' else 2])))
        receipts = checkout / RECEIPTS
        if receipts.is_dir() and not receipts.is_symlink():
            # A checkout from before the link: move its per-run receipts into the main store, then link.
            for run in receipts.glob('*/*.json'):
                target = self.root / RECEIPTS / run.parent.name / run.name
                if run.name != 'gate-receipt.json' and not target.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(run, target)
            shutil.rmtree(receipts)
        (self.root / RECEIPTS).mkdir(parents=True, exist_ok=True)
        for name in names:
            link = checkout / name
            # A directory the older per-file links left (.local/library holding only a current.json link): replace it.
            if link.is_dir() and not link.is_symlink() and all(p.is_symlink() for p in link.iterdir()):
                shutil.rmtree(link)
            if not os.path.lexists(link):
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(self.root / name)

    def run_gate(self, logs_name, *extra, profile='commit'):
        """Runs gate.py in the runner checkout; returns (passed, red suite ids, receipt path)."""
        command = [sys.executable, '-I', str(self.gr / 'tools/qa/gate.py'), '--profile', profile,
                   '--checkout', str(self.gr), '--logs', str(self.logs / logs_name), *extra]
        print(' '.join(command), flush=True)
        self.logs.mkdir(parents=True, exist_ok=True)
        done = subprocess.run(command, cwd=self.gr, env=dict(os.environ, **{LOCK_HELD: '1'}), stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
        print(done.stdout, end='', flush=True)
        lines = done.stdout.splitlines()
        receipt = next((line[len('receipt: '):] for line in reversed(lines) if line.startswith('receipt: ')), None)
        red = []
        if receipt and Path(receipt).is_file():
            red = [s['id'] for s in json.loads(Path(receipt).read_text()).get('suites', []) if s.get('status') == 'FAIL']
        prune(self.logs)
        return done.returncode == 0 and lines[-1:] == ['GATE PASS'], red, receipt

    def commit_info(self, sha):
        when, subject = git(self.root, 'log', '-1', '--format=%aI%x00%s', sha).split('\0', 1)
        return dict(sha=sha, author_time=when, subject=subject)

    def bisect(self, green, sha, red):
        """The first first-parent commit after green that fails red (sha itself fails); None without green."""
        if not green:
            return None
        commits = git(self.root, 'rev-list', '--first-parent', '--reverse', f'{green}..{sha}').split()
        lo, hi = 0, len(commits) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            with step(self.checkout_lock, f'gate-daemon bisect {commits[mid][:12]}'):
                self.checkout(self.gr, commits[mid])
                only = ['--only', ','.join(with_requires(self.gr, red))] if red else []
                passed = self.run_gate(commits[mid][:12], *only)[0]
            self.event('bisect', sha=commits[mid], result='PASS' if passed else 'FAIL')
            if passed:
                lo = mid + 1
            else:
                hi = mid
        with step(self.checkout_lock, f'gate-daemon checkout {sha[:12]}'):
            self.checkout(self.gr, sha)
        return self.commit_info(commits[lo])

    def verify(self, sha):
        before = self.load().get('last') or {}
        self.update(current=dict(sha=sha, kind='verify', started_at=utc()))
        try:
            with step(self.checkout_lock, f'gate-daemon verify {sha[:12]}'):
                self.checkout(self.gr, sha)
                passed, red, receipt = self.run_gate(sha[:12])
            first_red, reran = red, not passed
            if reran:
                self.event('rerun', sha=sha, suites=red)
                with step(self.checkout_lock, f'gate-daemon rerun {sha[:12]}'):
                    self.checkout(self.gr, sha)
                    passed, red, receipt = self.run_gate(f'{sha[:12]}-rerun')
            if passed:
                git(self.root, 'update-ref', GREEN, sha)
                self.event('green', sha=sha, receipt=receipt)
                if reran:
                    flaky = self.load().get('flaky', [])[-19:] + [dict(sha=sha, suites=first_red, at=utc())]
                    self.update(flaky=flaky)
                if before.get('result') == 'FAIL':
                    notify('Endfield 门禁转绿', f'{sha[:8]} 通过 commit 档')
            else:
                first_bad = self.bisect(rev(self.root, GREEN), sha, red)
                self.update(last_red=dict(sha=sha, suites=red, at=utc(), receipt=receipt, first_bad=first_bad))
                self.event('red', sha=sha, suites=red, first_bad=first_bad)
                culprit = f'，首个红提交 {first_bad["sha"][:8]} {first_bad["subject"]}' if first_bad else ''
                notify('Endfield 门禁红', f'{sha[:8]} 红: {", ".join(red) or "见日志"}{culprit}')
            self.update(verified=sha, last=dict(sha=sha, result='PASS' if passed else 'FAIL', red=red,
                                                receipt=receipt, finished_at=utc()))
        finally:
            self.update(current=None)

    def full_run(self, sha):
        with step(self.checkout_lock, f'gate-daemon no-cache {sha[:12]}'):
            self.update(current=dict(sha=sha, kind='no-cache', started_at=utc()))
            try:
                self.checkout(self.gr, sha)
                passed, red, receipt = self.run_gate(f'{sha[:12]}-full', '--no-cache')
                self.update(last_full=dict(sha=sha, result='PASS' if passed else 'FAIL', red=red, receipt=receipt,
                                           at=utc()))
                self.event('no-cache', sha=sha, result='PASS' if passed else 'FAIL', suites=red)
                if not passed:
                    notify('Endfield 门禁红', f'{sha[:8]} 无缓存全量红: {", ".join(red) or "见日志"}')
            finally:
                self.update(current=None)

    def tick(self):
        """One poll; returns True when the checked-out gate_daemon.py differs from the running one."""
        status = self.load()
        main = rev(self.root, MAIN)
        if main and main != status.get('verified'):
            self.verify(main)
            mine = self.gr / 'tools/qa/gate_daemon.py'
            return mine.is_file() and sha256(mine) != self.self_hash
        green = rev(self.root, GREEN)
        last_full = status.get('last_full')
        if green and (not last_full or
                      datetime.datetime.now(datetime.timezone.utc) - parse_utc(last_full['at']) > FULL_EVERY):
            self.full_run(green)
        return False


def serve(daemon):
    if not acquire(daemon.daemon_lock, 'gate-daemon serve', wait=False):
        print(f'gate-daemon: already running (pid {lock_pid(daemon.daemon_lock)})', file=sys.stderr)
        return 1
    daemon.update(pid=os.getpid(), started_at=utc(), current=None)
    daemon.event('serve', pid=os.getpid())
    while True:
        restart = False
        try:
            restart = daemon.tick()
        except Exception:
            traceback.print_exc()
            daemon.event('error', error=traceback.format_exc().splitlines()[-1])
        if restart:
            daemon.event('restart')
            script = str(daemon.gr / 'tools/qa/gate_daemon.py')
            os.execv(sys.executable, [sys.executable, '-I', script, 'serve'])
        time.sleep(POLL_S)


def ensure(daemon):
    pid = lock_pid(daemon.daemon_lock)
    if pid is not None and alive(pid):
        print(f'gate-daemon: running, pid {pid}')
        return 0
    # A runner stopped mid-bisect leaves gr on an older commit, whose gate_daemon.py would run.
    with held(daemon.checkout_lock, 'gate-daemon ensure'):
        daemon.checkout(daemon.gr, rev(daemon.root, MAIN))
    script = daemon.gr / 'tools/qa/gate_daemon.py'
    daemon.state.mkdir(parents=True, exist_ok=True)
    with open(daemon.state / 'daemon.log', 'a') as log:
        child = subprocess.Popen([sys.executable, '-I', str(script), 'serve'], cwd=daemon.gr, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    print(f'gate-daemon: started, pid {child.pid}, log {daemon.state / "daemon.log"}')
    return 0


def status(daemon, as_json):
    st = daemon.load()
    pid = lock_pid(daemon.daemon_lock)
    running = pid is not None and alive(pid)
    main, green = rev(daemon.root, MAIN), rev(daemon.root, GREEN)
    ahead = int(git(daemon.root, 'rev-list', '--count', f'{green}..{main}')) if green and main else None
    doc = dict(running=running, pid=pid if running else None, current=st.get('current') if running else None,
               main=main, green=green, ahead=ahead, last=st.get('last'), last_red=st.get('last_red'),
               flaky=st.get('flaky', []), last_full=st.get('last_full'), checkout_lock=owner(daemon.checkout_lock))
    if as_json:
        print(json.dumps(doc, indent=1))
        return 0
    current = doc['current']
    print(f'daemon: {"running, pid " + str(pid) if running else "not running (start: gate_daemon.py ensure)"}')
    if current:
        print(f'checking: {current["sha"][:12]} ({current["kind"]}) since {current["started_at"]}')
    print(f'main:  {main}')
    print(f'green: {green or "none"}' + (f' (main is {ahead} ahead)' if ahead is not None else ''))
    if doc['last']:
        print(f'last:  {doc["last"]["sha"][:12]} {doc["last"]["result"]} at {doc["last"]["finished_at"]}')
    red = doc['last_red']
    if red:
        print(f'last red: {red["sha"][:12]} at {red["at"]}: {", ".join(red["suites"]) or "see logs"}')
        bad = red.get('first_bad')
        if bad:
            print(f'  first red commit: {bad["sha"][:12]} {bad["author_time"]} {bad["subject"]}')
    for flaky in doc['flaky'][-5:]:
        print(f'flaky: {flaky["sha"][:12]} {", ".join(flaky["suites"])} at {flaky["at"]}')
    if doc['last_full']:
        full = doc['last_full']
        print(f'no-cache: {full["sha"][:12]} {full["result"]} at {full["at"]}')
    print(f'checkout lock: {doc["checkout_lock"] or "free"}')
    return 0


def gate_main(daemon, sha, profile):
    """Runs gate.py --profile profile on sha in the runner checkout; FAIL reruns once (a second PASS is recorded as flaky)."""
    with held(daemon.checkout_lock, f'gate-daemon {profile} {sha[:12]}'):
        daemon.checkout(daemon.gr, sha)
        passed, red, _ = daemon.run_gate(f'{sha[:12]}-{profile}', profile=profile)
        if not passed:
            daemon.event('rerun', sha=sha, suites=red)
            daemon.checkout(daemon.gr, sha)
            passed = daemon.run_gate(f'{sha[:12]}-{profile}-rerun', profile=profile)[0]
            if passed:
                daemon.update(flaky=daemon.load().get('flaky', [])[-19:] + [dict(sha=sha, suites=red, at=utc())])
    return passed


def pack(daemon, profile=None):
    """The gated release of main, which needs a PASS commit or release receipt; with profile, of that release profile."""
    sha = rev(daemon.root, MAIN)
    if profile:
        os.environ[PROFILE_ENV] = str(Path(profile).resolve())
    with held(daemon.pack_lock, f'gate-daemon pack {sha[:12]}'):
        daemon.checkout(daemon.pk, sha)
        if profile:
            try:
                gate_receipt.require(daemon.pk, source_fingerprint.compute(daemon.pk)[1])
            except ValueError:
                if not gate_main(daemon, sha, 'commit'):
                    print(f'pack {sha[:12]}: gate.py --profile commit under {os.environ[PROFILE_ENV]} failed, '
                          f'logs in {daemon.logs}')
                    return 1
        for package in ('web', 'app/electron'):
            subprocess.run(['npm', '--prefix', package, 'ci', '--ignore-scripts', '--prefer-offline'], cwd=daemon.pk,
                           check=True, stdout=subprocess.DEVNULL)
        built = subprocess.run(['bash', 'app/build_app.sh'], cwd=daemon.pk, stdout=subprocess.PIPE, text=True)
        # One-line receipts only: a failed smoke prints its JSON across lines, opening with a lone "{".
        receipts = [line for line in built.stdout.splitlines() if line.startswith('{') and line.endswith('}')]
        if built.returncode == 0 and receipts:
            kept = Path(json.loads(receipts[-1])['app']).parent.name
            for old in (daemon.pk / 'app/build/releases').glob('*'):
                if old.is_dir() and old.name != kept:
                    shutil.rmtree(old)
    daemon.state.mkdir(parents=True, exist_ok=True)
    (daemon.state / 'pack.log').write_text(built.stdout)
    if receipts:
        print(receipts[-1])
        print(f'app: {json.loads(receipts[-1]).get("app")}')
    print(f'pack {sha[:12]}: exit {built.returncode}, output {daemon.state / "pack.log"}')
    return built.returncode


def release(daemon, sha, profile=None):
    if profile:
        os.environ[PROFILE_ENV] = str(Path(profile).resolve())
    return 0 if gate_main(daemon, rev(daemon.root, sha or MAIN), 'release') else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('ensure')
    sub.add_parser('serve')
    sub.add_parser('link').add_argument('checkout', type=Path)
    sub.add_parser('status').add_argument('--json', action='store_true')
    sub.add_parser('pack').add_argument('--profile', type=Path)
    released = sub.add_parser('release')
    released.add_argument('--sha')
    released.add_argument('--profile', type=Path)
    args = parser.parse_args(argv)
    daemon = Daemon(main_root())
    if args.command == 'ensure':
        return ensure(daemon)
    if args.command == 'link':
        if args.checkout.resolve() == daemon.root.resolve():
            print('gate-daemon: link is for a worktree, not the main checkout', file=sys.stderr)
            return 1
        daemon.prepare(args.checkout.resolve())
        daemon.sync_venv(args.checkout.resolve())
        daemon.link(args.checkout.resolve())
        print(f'gate-daemon: linked inputs and agent/.venv into {args.checkout}')
        return 0
    if args.command == 'serve':
        return serve(daemon)
    if args.command == 'status':
        return status(daemon, args.json)
    if args.command == 'pack':
        return pack(daemon, args.profile)
    return release(daemon, args.sha, args.profile)


if __name__ == '__main__':
    sys.exit(main())
