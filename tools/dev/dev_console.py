#!/usr/bin/env python3
"""Local dev console: the web dev server and the real Electron shell, which supervises agentd, the renderer and the helper,
each from a chosen worktree, with the shell's pages from vite. Open http://127.0.0.1:48780/; see docs/development.md.
Arguments are passed on to the shell after the default ones (SHELL_ARGS), except the console's own:
  --release-renderer  the release renderer build (macOS; Windows has one build, so it changes nothing there)
  --python PATH       the Python agentd runs with (default: on macOS the main checkout's agent/.venv; on Windows
                      $AGENTD_PYTHON, else the main checkout's agent\\.venv\\Scripts\\python.exe)
  --catalog PATH      the character library (default: the release profile's; the sample library when it names none)
  --check             starts everything with a temporary support dir, waits for vite, the builds, agentd's health and
                      the renderer's hello (none without the renderer's sources), prints one DEV-CONSOLE-CHECK line and
                      stops everything
  --help, -h          prints this and exits
A start that fails before the shell runs and agentd answers (a step, or a config error in the shell's log) prints one
line and exits 1."""
import http.client
import http.server
import json
import ntpath
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/release'))
from release import default_profile  # noqa: E402
MAIN = Path(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                    text=True, encoding='utf-8').strip()).parent
RUN = MAIN / '.local/cache/dev-console'
PORT, AGENTD_PORT, WEB_PORT = 48780, 48790, 5190
# The installed app's agentd (protocol/ids.json `ports.agentd`).
INSTALLED_AGENTD_PORT = 48800
STATE_DIR = RUN / 'agentd-state'
# The shell's support dir, kept across runs: its config.json, logs, state.json and Chromium profile.
SUPPORT_DIR = RUN / 'support'
CONFIG = SUPPORT_DIR / 'config.json'
GPU_OWNER = MAIN / '.local/cache/gpu.lock/owner'
# Test runs leave push-to-talk and the observation samplers off, so the helper registers no key and samples nothing.
SHELL_ARGS = ['--no-push-to-talk', '--no-attention']
# 'debug', or 'release' with --release-renderer: the renderer at the app's frame rate, a whole-module recompile per edit.
RENDERER_BUILD = 'debug'
# The renderer's sources, under each renderer checkout; a public checkout has none and runs text-only characters.
RENDERER = 'private/renderer'


def renderer_sources(checkout):
    return (checkout / RENDERER).is_dir()
# --python and --catalog, when given.
PYTHON = CATALOG = None
# How long --check waits for each step, in seconds.
CHECK_SECONDS = {'vite': 1800, 'builds': 1800, 'agentd health': 120, 'renderer hello': 120}
CREATE_NEW_PROCESS_GROUP = 0x200
# Hosts a request may name (DNS rebinding).
HOSTS = {f'{h}:{PORT}' for h in ('127.0.0.1', 'localhost')}
ORIGINS = {'http://' + h for h in HOSTS}
# What a new config.json starts with: packaged.ts's defaults for what the shell may sense and share.
DEFAULTS = {'plugins': {'screen_awareness': False, 'computer_use': False}, 'sense_input_counts': False, 
            'share_page_text': False, 'share_window_text': False, 'share_typed_text': False, 'share_screenshots': False,
            'proactive_speech': False, 'system_notifications': False}
# The checkouts of the parts the shell runs; changing one restarts the shell.
PARTS = {'agentd': str(ROOT), 'renderer': str(ROOT)}


class Refused(Exception):
    """A run that would use the installed app's port or data."""


def installed_dirs(home, platform=sys.platform, env=None):
    if platform == 'win32':
        # app/electron/src/main/platform/index.ts defaultDirs.
        env = os.environ if env is None else env
        roaming = env.get('APPDATA') or ntpath.join(str(home), 'AppData', 'Roaming')
        local = env.get('LOCALAPPDATA') or ntpath.join(str(home), 'AppData', 'Local')
        return [ntpath.join(roaming, 'Agentic Complex'), ntpath.join(local, 'Agentic Complex')]
    ids = json.loads((ROOT / 'protocol/ids.json').read_text(encoding='utf-8'))['dirs']
    return [home / ids['companion_support'], home / ids['agentd_state'], home / ids['web_logs'],
            home / 'Library/Application Support/Agentic Complex']


def inside(path, directory, platform=sys.platform):
    if platform == 'win32':
        path, directory = (ntpath.normcase(ntpath.abspath(str(p))) for p in (path, directory))
        return path == directory or path.startswith(directory.rstrip('\\') + '\\')
    resolved, real = Path(os.path.realpath(path)), Path(os.path.realpath(directory))
    return resolved == real or real in resolved.parents


def check_isolated(support, state, port, args, home=None, platform=sys.platform, env=None):
    """Raises Refused when the shell would use the installed app's agentd port or a directory of its data, or when `args`
    name another config."""
    if port == INSTALLED_AGENTD_PORT:
        raise Refused(f'agentd port {port} is the installed app\'s')
    if '--config' in args:
        raise Refused('the shell arguments may not name --config; the console writes its own')
    for path in (support, state):
        for installed in installed_dirs(home or Path.home(), platform, env):
            if inside(path, installed, platform):
                raise Refused(f'{path} is in the installed app\'s {installed}')


def release_catalog():
    """The release character library the release profile names, its `.local` path in the main checkout; the sample
    library when it names none (the public profile)."""
    relative = json.loads(default_profile(ROOT).read_text(encoding='utf-8'))['character_catalog']
    return str(MAIN / relative) if relative is not None else str(ROOT / 'characters/sample-library/current.json')


def worktrees():
    """[{path, branch, head}] of every checkout of this repository."""
    out = subprocess.check_output(['git', '-C', str(MAIN), 'worktree', 'list', '--porcelain'], text=True, encoding='utf-8')
    trees = []
    for block in out.strip().split('\n\n'):
        fields = dict(line.split(' ', 1) if ' ' in line else (line, '') for line in block.splitlines())
        if 'worktree' in fields and 'prunable' not in fields:
            trees.append({'path': fields['worktree'], 'head': fields.get('HEAD', '')[:12],
                          'branch': fields.get('branch', 'detached').removeprefix('refs/heads/')})
    return trees


def agentd_python(platform=sys.platform):
    if PYTHON:
        return PYTHON
    if platform != 'win32':
        return str(MAIN / 'agent/.venv/bin/python')
    if os.environ.get('AGENTD_PYTHON'):
        return os.environ['AGENTD_PYTHON']
    venv = MAIN / 'agent/.venv/Scripts/python.exe'
    if not venv.exists():
        raise ValueError(f'no agentd Python: no {venv}; pass --python or set AGENTD_PYTHON')
    return str(venv)


def shell_config(existing, agentd, renderer, platform=sys.platform):
    """config.json for the shell (app/electron/src/common/config.ts): `existing`'s settings, the managed keys recomputed."""
    if platform == 'win32':
        # run.bat's only build.
        host = renderer / RENDERER / 'windows/build'
        executable = host / 'efw.exe'
    else:
        host = renderer / RENDERER / 'host/.build' / RENDERER_BUILD
        executable = host / 'metal-avatar-host'
    config = {**DEFAULTS, 'gpu_hold_files': [], **(existing or {}),
              'agentd_dir': str(agentd / 'agent/agentd'), 'python': agentd_python(platform),
              'agentd_port': AGENTD_PORT, 'support_dir': str(SUPPORT_DIR), 'agentd_state_dir': str(STATE_DIR),
              'character_catalog': CATALOG or release_catalog(), 'avatar_app': str(host),
              'avatar_executable': str(executable)}
    if not renderer_sources(renderer):
        config.pop('avatar_app'); config.pop('avatar_executable')
    return config


def write_config(agentd, renderer, platform=sys.platform):
    check_isolated(SUPPORT_DIR, STATE_DIR, AGENTD_PORT, [])
    SUPPORT_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    existing = json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else None
    temporary = CONFIG.with_name('config.json.tmp')
    temporary.write_text(json.dumps(shell_config(existing, agentd, renderer, platform), indent=2, ensure_ascii=False),
                         encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(CONFIG)
    return CONFIG


def shell_command(checkout, args, platform=sys.platform):
    electron = checkout / 'app/electron'
    rest = [electron, '--config', CONFIG, '--dev-web-server', f'http://127.0.0.1:{WEB_PORT}', *args]
    if platform == 'win32':
        # Windows has no gpu lock.
        return [electron / 'node_modules/electron/dist/electron.exe', *rest]
    return [ROOT / 'tools/platform/gpu-lock.sh', f'devconsole:{checkout.name}', electron / 'node_modules/.bin/electron', *rest]


def group_kwargs(platform=sys.platform):
    """Popen kwargs that start a child in its own group; on Windows that also keeps the console's Ctrl-C from it, so the
    console stops the children in order."""
    return {'creationflags': CREATE_NEW_PROCESS_GROUP} if platform == 'win32' else {'start_new_session': True}


def wait_for_web():
    """Until vite listens, so the shell's first pages do not come up as the unreachable error."""
    deadline = time.time() + 60
    while True:
        try:
            socket.create_connection(('127.0.0.1', WEB_PORT), timeout=1).close()
            return
        except OSError:
            if time.time() > deadline:
                raise
            time.sleep(0.5)


class Component:
    """One child process started from a chosen checkout; `generation` makes a stop win over a start still preparing."""

    def __init__(self, name):
        self.name, self.log = name, RUN / f'{name}.log'
        self.checkout = self.proc = None
        self.args = list(SHELL_ARGS)
        self.phase, self.started, self.generation = 'stopped', None, 0
        self.lock = threading.Lock()

    def snapshot(self):
        with self.lock:
            phase = self.phase
            if self.name == 'shell' and phase == 'preparing' and GPU_OWNER.exists() and 'devconsole:' not in GPU_OWNER.read_text(encoding='utf-8'):
                phase = 'gpuHold'
            return {'name': self.name, 'phase': phase, 'checkout': self.checkout, 'started': self.started, 'args': self.args,
                    'pid': self.proc.pid if self.proc and self.proc.poll() is None else None}

    def start(self, checkout, args=None):
        self.stop()
        with self.lock:
            self.generation += 1
            self.checkout, self.phase, self.started = checkout, 'preparing', time.time()
            if args is not None:
                self.args = list(args)
            generation = self.generation
        threading.Thread(target=self._run, args=(generation, Path(checkout)), daemon=True).start()

    def _spawn(self, generation, command, **kw):
        """Starts `command` in its own process group with output in the log; None when stopped meanwhile."""
        with self.lock:
            if generation != self.generation:
                return None
            with self.log.open('ab') as log:
                log.write(f'\n$ {" ".join(map(str, command))}\n'.encode())
                log.flush()
                self.proc = subprocess.Popen([str(c) for c in command], stdout=log, stderr=subprocess.STDOUT,
                                             stdin=subprocess.DEVNULL, **group_kwargs(), **kw)
            return self.proc

    def _run(self, generation, checkout):
        try:
            for command, kw, mode in self.steps(checkout):
                if mode == 'call':
                    command()
                    continue
                proc = self._spawn(generation, command, **kw)
                if proc is None:
                    return
                if mode == 'wait' and proc.wait() != 0:
                    return self._finish(generation, f'failed(exit {proc.returncode})')
                if mode == 'run':
                    with self.lock:
                        if generation == self.generation:
                            self.phase = 'running'
                    proc.wait()
                    return self._finish(generation, 'stopped' if proc.returncode in (0, -signal.SIGTERM) else f'failed(exit {proc.returncode})')
        except (OSError, ValueError, KeyError, Refused) as e:
            self._finish(generation, f'failed({e})')

    def _finish(self, generation, phase):
        with self.lock:
            if generation == self.generation:
                self.phase = phase

    def steps(self, checkout, platform=sys.platform):
        """[(command, Popen kwargs, 'wait' | 'run')] or [(callable, {}, 'call')]: preparation, then the long-running process."""
        npm, npx = ('npm.cmd', 'npx.cmd') if platform == 'win32' else ('npm', 'npx')
        if self.name == 'web':
            web = checkout / 'web'
            steps = []
            if not (web / 'node_modules').exists():
                steps.append(([npm, 'ci', '--ignore-scripts', '--prefer-offline'], {'cwd': web}, 'wait'))
            env = {**os.environ, 'EF_DEV_HMR_PORT': str(WEB_PORT)}
            return steps + [([npx, 'vite', '--host', '127.0.0.1', '--port', WEB_PORT, '--strictPort'], {'cwd': web, 'env': env}, 'run')]
        electron, agentd, renderer = checkout / 'app/electron', Path(PARTS['agentd']), Path(PARTS['renderer'])
        steps = []
        if not (electron / 'node_modules').exists():
            steps.append(([npm, 'ci', '--ignore-scripts', '--prefer-offline'], {'cwd': electron}, 'wait'))
        # The gate's `npm ci --ignore-scripts` leaves the Electron runtime out.
        if not (electron / 'node_modules/electron/dist').exists():
            steps.append((['node', electron / 'node_modules/electron/install.js'], {'cwd': electron}, 'wait'))
        if platform == 'win32':
            builds = [
                # Into <checkout>\.local\build\helper-windows, where helperExecutable looks in a repo launch.
                (['cmd', '/d', '/c', 'build.bat'], {'cwd': checkout / 'app/helpers/windows'}, 'wait'),
                # It rebuilds everything each time; there is no release build.
                (['cmd', '/d', '/c', 'run.bat'], {'cwd': renderer / RENDERER / 'windows'}, 'wait'),
            ]
        else:
            builds = [
                # Where helperExecutable looks in a repo launch.
                (['swift', 'build', '-c', 'release', '--package-path', checkout / 'app/helpers/mac'], {}, 'wait'),
                # Debug by default: release compiles MetalAvatarHost as one whole module, so any edit recompiles all of it.
                (['swift', 'build', *(['-c', 'release'] if RENDERER_BUILD == 'release' else []),
                  '--package-path', renderer / RENDERER / 'host', '--product', 'metal-avatar-host'], {}, 'wait'),
            ]
        if not renderer_sources(renderer):
            builds = builds[:1]
        return steps + [
            ([npm, 'run', 'build'], {'cwd': electron}, 'wait'),
            *builds,
            (lambda: write_config(agentd, renderer, platform), {}, 'call'),
            (wait_for_web, {}, 'call'),
            (shell_command(checkout, self.args, platform), {}, 'run'),
        ]

    def stop(self, platform=sys.platform):
        with self.lock:
            self.generation += 1
            proc, self.proc = self.proc, None
            shell = self.name == 'shell' and self.phase == 'running'
            self.phase = 'stopped'
        if proc and proc.poll() is None and platform == 'win32':
            # No signals or process groups: the whole tree at once, so the shell does not stop its children in order.
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True)
            proc.wait()
        elif proc and proc.poll() is None:
            try:
                # A lock waiter also has children (sleep, mkdir). Only the Electron launcher handles an ordered quit.
                if shell and os.environ.get('AAC_LOCK_HELD_gpu'):
                    os.kill(proc.pid, signal.SIGTERM)
                elif shell and (child := subprocess.run(
                        ['pgrep', '-P', str(proc.pid), '-f', '(^|/)node .*/node_modules/[.]bin/electron '],
                        capture_output=True, text=True).stdout.strip()):
                    os.kill(int(child), signal.SIGTERM)
                else:
                    os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=30)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
            # What is left of the group.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()


COMPONENTS = {name: Component(name) for name in ('web', 'shell')}
LOGS = {'web': RUN / 'web.log', 'shell': RUN / 'shell.log', 'companion': SUPPORT_DIR / 'logs/companion.log',
        'agentd': SUPPORT_DIR / 'logs/agentd.log', 'renderer': SUPPORT_DIR / 'logs/avatar.log', 'helper': SUPPORT_DIR / 'logs/helper.log'}


def stop_all():
    """The shell first: its pages and the renderer's link go before vite does."""
    for name in ('shell', 'web'):
        COMPONENTS[name].stop()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self):
        origin = self.headers.get('Origin')
        if self.headers.get('Host') not in HOSTS or (origin is not None and origin not in ORIGINS):
            self._json(403, {'error': 'forbidden_origin'})
            return False
        return True

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        value = json.loads(self.rfile.read(length) or b'{}')
        if not isinstance(value, dict):
            raise ValueError('expected a JSON object')
        return value

    def do_GET(self):
        if not self._allowed():
            return
        path, _, query = self.path.partition('?')
        if path == '/':
            data = (Path(__file__).parent / 'console.html').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif path == '/api/state':
            owner = GPU_OWNER.read_text().strip() if GPU_OWNER.exists() else None
            self._json(200, {'worktrees': worktrees(), 'components': {n: c.snapshot() for n, c in COMPONENTS.items()},
                             'parts': PARTS, 'gpu_lock': owner, 'config': str(CONFIG)})
        elif path == '/api/log' and query.removeprefix('component=') in LOGS:
            log = LOGS[query.removeprefix('component=')]
            data = log.read_bytes()[-65536:] if log.exists() else b''
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self._json(404, {'error': 'not_found'})

    def do_POST(self):
        if not self._allowed():
            return
        try:
            message = self._body()
        except ValueError as e:
            return self._json(400, {'error': 'invalid_body', 'detail': str(e)})
        name = message.get('component')
        if self.path == '/api/start' and (name in COMPONENTS or name in PARTS):
            if message.get('checkout') not in {t['path'] for t in worktrees()}:
                return self._json(400, {'error': 'unknown_checkout'})
            args = message.get('args')
            if args is not None and not (isinstance(args, list) and all(isinstance(a, str) for a in args)):
                return self._json(400, {'error': 'invalid_args'})
            try:
                check_isolated(SUPPORT_DIR, STATE_DIR, AGENTD_PORT, args or [])
            except Refused as e:
                return self._json(400, {'error': 'refused', 'detail': str(e)})
            if name in PARTS:
                PARTS[name] = message['checkout']
                shell = COMPONENTS['shell']
                if shell.checkout:
                    shell.start(shell.checkout)
            else:
                COMPONENTS[name].start(message['checkout'], args if name == 'shell' else None)
            self._json(200, {})
        elif self.path == '/api/stop' and name in COMPONENTS:
            COMPONENTS[name].stop()
            self._json(200, {})
        else:
            self._json(404, {'error': 'not_found'})


def web_listening():
    try:
        socket.create_connection(('127.0.0.1', WEB_PORT), timeout=1).close()
        return True
    except OSError:
        return False


def shell_running():
    return COMPONENTS['shell'].snapshot()['phase'] == 'running'


def agentd_ready():
    # http.client, not urllib: no system proxy between here and 127.0.0.1.
    connection = http.client.HTTPConnection('127.0.0.1', AGENTD_PORT, timeout=2)
    try:
        connection.request('GET', '/health')
        return json.loads(connection.getresponse().read()).get('status') == 'ok'
    except (OSError, ValueError, AttributeError):
        return False
    finally:
        connection.close()


def renderer_hello():
    log = SUPPORT_DIR / 'logs/companion.log'
    return log.exists() and 'HOSTLINK hello character=' in log.read_text(encoding='utf-8', errors='replace')


def startup_failure(log_start):
    """Why the start failed: a component that ended in failure, or a config error the shell logged past byte `log_start`
    of companion.log; None while neither."""
    for name, component in COMPONENTS.items():
        if (phase := component.snapshot()['phase']).startswith('failed'):
            return f'{name} {phase}; log {component.log}'
    log = SUPPORT_DIR / 'logs/companion.log'
    if log.exists():
        with log.open('rb') as f:
            f.seek(log_start)
            for line in f.read().decode('utf-8', errors='replace').splitlines():
                if 'ERROR config' in line:
                    return f'shell config: {line.strip()}; log {log}'
    return None


def watch_startup(server, log_start, failed):
    """Until the shell runs and agentd answers: on a failure, prints it, notes it in `failed` and stops `server`."""
    while not (shell_running() and agentd_ready()):
        if failure := startup_failure(log_start):
            print(f'dev console: {failure}', file=sys.stderr, flush=True)
            failed.append(failure)
            server.shutdown()
            return
        time.sleep(0.5)


def run_check(tmp, args):
    """--check: starts web and the shell, waits for each step in turn, stops everything, then prints the one result line
    (`tmp` removed on a pass, else named in it); the exit code."""
    began, passed, failure = time.time(), [], None
    catalog = CATALOG or release_catalog()
    if not (catalog and Path(catalog).is_file()):
        failure = f'character library (no {catalog or "library in the release profile"}; pass --catalog)'
    else:
        COMPONENTS['web'].start(str(ROOT))
        COMPONENTS['shell'].start(str(ROOT), args)
        try:
            probes = [('vite', web_listening), ('builds', shell_running), ('agentd health', agentd_ready)]
            if renderer_sources(Path(PARTS['renderer'])):
                probes.append(('renderer hello', renderer_hello))
            for name, probe in probes:
                deadline = time.time() + CHECK_SECONDS[name]
                while failure is None and not probe():
                    ended = [f'{n} {p}' for n, c in COMPONENTS.items() if (p := c.snapshot()['phase']) not in ('preparing', 'gpuHold', 'running')]
                    if ended or time.time() > deadline:
                        failure = f'{name} ({", ".join(ended) or f"not within {CHECK_SECONDS[name]} s"})'
                    time.sleep(0.5)
                if failure:
                    break
                passed.append(name)
        finally:
            stop_all()
    if failure is None:
        shutil.rmtree(tmp, ignore_errors=True)
        print(f'DEV-CONSOLE-CHECK pass: {", ".join(passed)} in {round(time.time() - began)} s', flush=True)
        return 0
    print(f'DEV-CONSOLE-CHECK fail at {failure}; passed {", ".join(passed) or "nothing"}; logs in {tmp}', flush=True)
    return 1


def take(args, flag):
    """The value after `flag`, both removed from `args`; None when `flag` is not there."""
    if flag not in args:
        return None
    i = args.index(flag)
    if i + 1 == len(args):
        sys.exit(f'dev console: {flag} needs a value')
    value = args[i + 1]
    del args[i:i + 2]
    return value


def main(argv=None):
    global RENDERER_BUILD, PYTHON, CATALOG, SUPPORT_DIR, STATE_DIR, CONFIG
    if sys.platform == 'win32':
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    own = list(sys.argv[1:] if argv is None else argv)
    if '--help' in own or '-h' in own:
        print(__doc__)
        sys.exit(0)
    if '--release-renderer' in own:
        own.remove('--release-renderer')
        RENDERER_BUILD = 'release'
    PYTHON, CATALOG = take(own, '--python'), take(own, '--catalog')
    check = '--check' in own
    if check:
        own.remove('--check')
        tmp = Path(tempfile.mkdtemp(prefix='dev-console-check-'))
        SUPPORT_DIR, STATE_DIR = tmp / 'support', tmp / 'agentd-state'
        CONFIG = SUPPORT_DIR / 'config.json'
        for name, component in COMPONENTS.items():
            component.log = tmp / f'{name}.log'
    args = SHELL_ARGS + own
    try:
        check_isolated(SUPPORT_DIR, STATE_DIR, AGENTD_PORT, args)
    except Refused as e:
        sys.exit(f'dev console: {e}')
    if check:
        sys.exit(run_check(tmp, args))
    RUN.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    stop = lambda *_: threading.Thread(target=server.shutdown).start()  # noqa: E731
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'dev console on http://127.0.0.1:{PORT}/ ; logs in {RUN}', flush=True)
    companion_log = SUPPORT_DIR / 'logs/companion.log'
    log_start, failed = companion_log.stat().st_size if companion_log.exists() else 0, []
    COMPONENTS['web'].start(str(ROOT))
    COMPONENTS['shell'].start(str(ROOT), args)
    threading.Thread(target=watch_startup, args=(server, log_start, failed), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop_all()
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
