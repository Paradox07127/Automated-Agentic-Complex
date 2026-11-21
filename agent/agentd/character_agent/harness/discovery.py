"""Bounded, read-only discovery of native harness entry points and login state."""
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import tempfile
import time

from fsutil import atomic_write_json, read_json


def _probe(argv, backend, timeout, env=None):
    from character_agent.harness.transport import runner_environment
    with tempfile.TemporaryDirectory(prefix='endfield-native-probe-') as directory:
        root = Path(directory)
        protected_env = runner_environment(root, auth_mode='existing_login')
        if env:
            protected_env.update({k:v for k,v in env.items() if k in ('HOME','USER','LOGNAME','CLAUDE_CONFIG_DIR','CODEX_HOME','SSL_CERT_FILE','SSL_CERT_DIR')})
        if backend == 'codex':
            argv = [argv[0], '-c', 'sqlite_home='+json.dumps(str(root/'sqlite')),
                    '-c', 'log_dir='+json.dumps(str(root/'logs')), *argv[1:]]
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=protected_env, cwd=root/'workspace', encoding="utf-8")


def native_status(path, backend):
    """Return only auth category/boolean. Account identities never leave here."""
    argv = [str(path), "auth", "status", "--json"] if backend == "claude" else [str(path), "login", "status"]
    env = {k: v for k, v in os.environ.items() if k in (
        "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR")}
    try:
        process = _probe(argv, backend, 8, env)
        if backend == "claude":
            result = json.loads(process.stdout)
            result = result if isinstance(result, dict) else {}
            mode = result.get("authMethod", "unknown")
            mode = mode if mode in ("claude.ai", "api_key", "oauth_token", "api_key_helper", "third_party", "none") else "unknown"
            authenticated = process.returncode == 0 and result.get("loggedIn") is True
        else:
            output = (process.stdout + "\n" + process.stderr).lower()
            mode = "chatgpt" if "chatgpt" in output else "api_key" if "api key" in output \
                else "access_token" if "access token" in output else "unknown"
            authenticated = process.returncode == 0
        return {"authenticated": authenticated, "auth_mode": "existing_login" if authenticated else "none",
                "auth_method": mode if authenticated else "none"}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"authenticated": False, "auth_mode": "none", "auth_method": "unknown", "auth_error": "status_unavailable"}


def runtime_version(path, backend, timeout=5):
    try:
        result = _probe([str(path), "--version"], backend, timeout)
        pattern = r"^(\d+\.\d+\.\d+)(?:\s|$)" if backend == "claude" else r"^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)"
        found = re.search(pattern, result.stdout.strip())
        return found.group(1) if result.returncode == 0 and found else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def entry_supported(path, backend, timeout=5):
    """Probe the required protocol entry; the version is diagnostic metadata."""
    argv = [str(path), "--help"] if backend == "claude" else [str(path), "app-server", "--help"]
    try:
        result = _probe(argv, backend, timeout)
        return result.returncode == 0 and ("--input-format" in result.stdout and "--output-format" in result.stdout
                                           if backend == "claude" else "--listen" in result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def _parallel(fn, items, width):
    """`fn` over `items`, `width` at a time, in order. Daemon threads: agentd's exit does not wait out probes, which
    ThreadPoolExecutor's workers would (they are joined at interpreter exit)."""
    results, errors, gate = [None] * len(items), [], threading.Semaphore(width)
    def run(i, item):
        with gate:
            try:
                results[i] = fn(item)
            except BaseException as exc:
                errors.append(exc)
    threads = [threading.Thread(target=run, args=(i, item), name="runtime-discovery", daemon=True)
               for i, item in enumerate(items)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if errors:
        raise errors[0]
    return results


AUTH_KEYS = ("authenticated", "auth_mode", "auth_method", "auth_error")  # the fields native_status answers


class DiscoveryService:
    """cache_seconds: how long a login state holds, since it can change outside; scan_seconds: how long a scan of
    unchanged executables holds."""
    def __init__(self, cache_seconds=30, *, scan_seconds=600, candidates=None, clock=time.time, path=None):
        self.cache_seconds, self.scan_seconds, self.clock = cache_seconds, scan_seconds, clock
        self.candidates = candidates
        self.path = path  # the last completed scan, kept across restarts
        self._lock = threading.Lock()  # guards the cache; held only for bookkeeping, never across probes
        self._scanning = threading.Lock()  # one probe run at a time
        self._cached = None
        self._identities = None
        self._login_at = None  # when the cached runtimes' login states were probed
        self._scans = 0  # completed scans; counts instead of timestamps so equal clock ticks cannot coalesce
        self._background = None  # the thread re-scanning the cache, while it runs
        self._inspected = {}
        self._inspecting = set()
        self._load()

    def _load(self):
        if self.path is None:
            return
        try:
            value = read_json(self.path)
            runtimes, identities, scanned_at = value["runtimes"], value["identities"], float(value["scanned_at"])
            if not isinstance(runtimes, list) or not isinstance(identities, list) or len(runtimes) != len(identities) or \
                    not all(isinstance(row, dict) and isinstance(row.get("path"), str) and
                            row.get("backend") in ("codex", "claude") and row.get("runtime_source") != "bundled"
                            for row in runtimes):
                raise ValueError("invalid_runtime_discovery")
            identities = [tuple(identity) if identity is not None else None for identity in identities]
        except (OSError, ValueError, KeyError, TypeError):
            return
        self._cached, self._identities = {"runtimes": runtimes, "scanned_at": scanned_at}, identities
        self._login_at = scanned_at

    @staticmethod
    def _identity(path):
        try:
            stat = Path(path).stat()
            return (str(Path(path).resolve()), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        except OSError:
            return None

    def _inspect(self, candidate):
        backend, source, path = candidate
        version = runtime_version(path, backend)
        supported = entry_supported(path, backend)
        # Login/help are not a tool-boundary audit. The actual app-server
        # verifies effective policy and exposed tools before a model can use them.
        info = {"backend":backend, "runtime_source":source, "path":str(Path(path).absolute()),
                "version":version or "unknown", "entry_supported":supported, "boundary_verified":None,
                "reason":None if supported else "runtime_protocol_unavailable",
                "compatibility":{"strategy":"runtime_capabilities", "version_required":False,
                                 "policy_verification":"on_session_start"}, **native_status(path,backend)}
        return info

    def _local_candidates(self):
        if self.candidates is not None:
            return self.candidates
        home = Path.home()
        result = []
        known = {"codex": [Path("/opt/homebrew/bin/codex"), Path("/usr/local/bin/codex"), home / ".local/bin/codex"],
                 "claude": [home / ".local/bin/claude", Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude")]}
        for backend, paths in known.items():
            entry = shutil.which(backend)
            if entry:
                paths.insert(0, Path(entry))
            result.extend((backend, "local_cli", path) for path in paths)
        # Only documented CLI-shaped resource locations; never execute the GUI
        # application's CFBundleExecutable as though it were a CLI.
        for directory in (Path("/Applications"), home / "Applications"):
            result.append(("codex", "app_cli", directory / "Codex.app/Contents/Resources/codex"))
            result.append(("codex", "app_cli", directory / "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"))
        return result

    def scan(self, refresh=False, *, wait=True):
        """Answers from any cache at once; only refresh, or no cache at all, waits for the probes, which take seconds."""
        called = self._scans
        if not refresh:
            with self._lock:
                if self._cached is not None:
                    if self._stale():
                        self._start_background()
                    elif self.clock() - self._login_at >= self.cache_seconds:
                        self._start_background(login=True)
                    return copy.deepcopy(self._cached)
                if not wait:
                    self._start_background()
                    return {'runtimes': [], 'scanned_at': None}
        return self._scan(refresh, called)

    def warm(self):
        """Starts a background scan, so the first request after agentd starts finds the probes done."""
        with self._lock:
            self._start_background()

    def _changed(self):
        return [self._identity(row["path"]) for row in self._cached["runtimes"]] != self._identities

    def _stale(self):
        return self._changed() or self.clock() - self._cached["scanned_at"] >= self.scan_seconds

    def _start_background(self, login=False):
        if self._background is None:
            self._background = threading.Thread(target=self._relogin if login else self._rescan, args=(self._scans,),
                                                name="runtime-discovery-refresh", daemon=True)
            self._background.start()

    def _scan(self, refresh, called):
        with self._scanning:
            with self._lock:
                # A call that queued behind a scan finishing after it was made reuses that scan.
                if self._cached is not None and (not refresh or self._scans != called and not self._changed()):
                    return copy.deepcopy(self._cached)
            now = self.clock()
            selected, seen = [], set()
            for backend, source, path in self._local_candidates():
                path = Path(path)
                if not path.is_file() or not os.access(path, os.X_OK):
                    continue
                resolved = str(path.resolve())
                if (backend, resolved) in seen:
                    continue
                seen.add((backend, resolved))
                selected.append((backend,source,path))
            result = _parallel(self._inspect, selected, 4)
            identities = [self._identity(row['path']) for row in result]
            with self._lock:
                self._cached = {"runtimes": result, "scanned_at": now}
                self._identities = identities
                self._login_at = now
                self._scans += 1
                value = copy.deepcopy(self._cached)
            self._save(value, identities)
            return value

    def _save(self, value, identities):
        if self.path is not None:
            try:
                atomic_write_json(self.path, {**value, "identities": identities})
            except OSError as exc:
                print("runtime discovery not saved: " + type(exc).__name__, file=sys.stderr)

    def _rescan(self, called):
        try:
            self._scan(True, called)
        finally:
            self._background = None

    def _relogin(self, called):
        """Probes only the cached runtimes' login states again; a scan that finished first leaves them as it found."""
        try:
            with self._scanning:
                with self._lock:
                    if self._scans != called:
                        return
                    rows = self._cached["runtimes"]
                now = self.clock()
                logins = _parallel(lambda row: native_status(row["path"], row["backend"]), rows, 4)
                with self._lock:
                    if self._scans != called:
                        return
                    self._cached = {**self._cached, "runtimes": [
                        {**{k: v for k, v in row.items() if k not in AUTH_KEYS}, **login}
                        for row, login in zip(rows, logins)]}
                    self._login_at = now
                    value, identities = copy.deepcopy(self._cached), self._identities
                self._save(value, identities)
        finally:
            self._background = None

    def inspect_runtime(self, path, backend, refresh=False, *, wait=True):
        """Inspect an explicitly selected executable without changing native auth."""
        if backend not in ("codex", "claude") or not isinstance(path, (str, Path)):
            return None
        candidate = Path(path)
        if not candidate.is_absolute() or not candidate.is_file() or not os.access(candidate, os.X_OK):
            return None
        identity = self._identity(candidate)
        if identity is None: return None
        key = (backend, str(candidate))
        with self._lock:
            cached = self._inspected.get(key)
            if not refresh and cached and cached[0] == identity and self.clock()-cached[1] < self.cache_seconds:
                return copy.deepcopy(cached[2])
            if not refresh and self._cached is not None and self.clock()-self._login_at < self.cache_seconds:
                for row, scanned_identity in zip(self._cached['runtimes'], self._identities):
                    if row.get('backend') == backend and scanned_identity == identity:
                        return {**copy.deepcopy(row), 'path': str(candidate), 'runtime_source': 'local_cli'}
            if not wait:
                if key not in self._inspecting:
                    self._inspecting.add(key)
                    def inspect():
                        try:
                            self.inspect_runtime(path, backend, refresh=True)
                        finally:
                            with self._lock: self._inspecting.discard(key)
                    threading.Thread(target=inspect, name='runtime-explicit-probe', daemon=True).start()
                return None
        # Reuse the same bounded probes and schema as discovery; this path is
        # selected by the user, never inferred from model output.
        found = self._inspect((backend, 'local_cli', candidate))
        with self._lock:
            if len(self._inspected) >= 32: self._inspected.clear()
            self._inspected[key] = (identity,self.clock(),found)
        return copy.deepcopy(found)
