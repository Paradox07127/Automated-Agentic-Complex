"""Sign-in started from the app. Codex and Claude Code sign in to Agentic Complex's own profile of each
(NATIVE_HOME_VAR); an ACP agent signs in to its own login. The kernels store the credentials: nothing here reads them."""
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
import webbrowser

from character_agent.harness.discovery import _probe
from character_agent.harness.transport import NATIVE_HOME_VAR, runner_environment
from fsutil import atomic_write_json, read_json
from infra.platform import make_private_dir, new_group_options, release_group, signal_group, track_group

TIMEOUT = 300  # seconds a sign-in waits for the browser
STATUS_SECONDS = 60  # how long a probed sign-in state holds
# Codex otherwise writes its tokens to CODEX_HOME/auth.json; "keyring" fails instead of falling back to the file.
CODEX_CONFIG = 'cli_auth_credentials_store = "keyring"\n'


class KernelLogin:
    def __init__(self, state_dir, *, open_url=webbrowser.open, on_acp_login=None):
        self.root = Path(state_dir) / "kernel-login"
        self.open_url = open_url
        self.on_acp_login = on_acp_login  # (agent id, signed in) after an ACP sign-in or sign-out
        self.lock = threading.Lock()
        self.attempt = None  # {"backend", "acp_agent", "proc" | "cancel"} while a sign-in runs
        self.error = None  # the code the last sign-in failed with
        self.detail = None  # the kernel's own words for that failure, when it gave some
        self.status = {}  # backend -> {"signed_in", "email", "plan", "at"}
        self.probing = set()

    def home(self, backend):
        """Agentic Complex's own profile directory of Codex or Claude Code."""
        path = self.root / backend
        make_private_dir(self.root)
        make_private_dir(path)
        if backend == "codex" and not (path / "config.toml").exists():
            (path / "config.toml").write_text(CODEX_CONFIG, encoding="utf-8")
        return path

    def _env(self, backend):
        env = runner_environment(self.root / "run", auth_mode="product_login")
        env[NATIVE_HOME_VAR[backend]] = str(self.home(backend))
        return env

    def public(self):
        with self.lock:
            attempt = self.attempt
            return {"pending": {"backend": attempt["backend"], "acp_agent": attempt["acp_agent"]} if attempt else None,
                    "error": self.error, "detail": self.detail,
                    "accounts": {b: {k: s[k] for k in ("signed_in", "email", "plan")} for b, s in self.status.items()}}

    def signed_in(self, backend, cli, wait):
        """Whether the app's profile of `backend` is signed in; None while the first probe runs without `wait`."""
        with self.lock:
            known = self.status.get(backend)
            stale = known is None or time.monotonic() - known["at"] >= STATUS_SECONDS
            if stale and backend not in self.probing and not (known is None and wait):
                self.probing.add(backend)
                threading.Thread(target=self._refresh, args=(backend, cli), daemon=True).start()
        if known is None and wait:
            self._refresh(backend, cli)
            known = self.status[backend]
        return None if known is None else known["signed_in"]

    def _refresh(self, backend, cli):
        try:
            value = self._probe(backend, cli)
        finally:
            with self.lock:
                self.probing.discard(backend)
        with self.lock:
            self.status[backend] = {**value, "at": time.monotonic()}

    def _probe(self, backend, cli):
        env = {NATIVE_HOME_VAR[backend]: str(self.home(backend))}
        try:
            if backend == "claude":
                result = json.loads(_probe([cli, "auth", "status", "--json"], backend, 8, env).stdout)
                ok = isinstance(result, dict) and result.get("loggedIn") is True
                return {"signed_in": ok, "email": result.get("email") if ok else None,
                        "plan": result.get("subscriptionType") if ok else None}
            ok = _probe([cli, "login", "status"], backend, 8, env).returncode == 0
            path = self.home(backend) / "account.json"
            account = read_json(path) if ok and path.exists() else {}
            return {"signed_in": ok, "email": account.get("email"), "plan": account.get("plan")}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return {"signed_in": False, "email": None, "plan": None}

    def start(self, backend, cli=None, *, agent=None, method=None):
        """Starts one sign-in: Codex or Claude Code with executable `cli`, or ACP `agent` ({id, command[, env]}) with
        one of its `authMethods` entries `method`. The browser and the kernel finish it."""
        with self.lock:
            if self.attempt:
                raise ValueError("login_pending")
            self.attempt = {"backend": backend, "acp_agent": agent["id"] if agent else None}
            self.error = self.detail = None
        target = {"codex": self._codex, "claude": self._claude}.get(backend) or self._acp
        args = (cli,) if agent is None else (agent, method)
        threading.Thread(target=self._run, args=(backend, target, args), daemon=True, name="kernel-login").start()
        return self.public()

    def _run(self, backend, target, args):
        error = detail = None
        try:
            target(*args)
        except LoginFailed as failure:
            error, detail = failure.code, failure.detail
        except (OSError, ValueError):
            error = "login_failed"
        with self.lock:
            cancelled = self.attempt is not None and self.attempt.get("cancelled")
            self.attempt = None
            self.error, self.detail = (None, None) if cancelled else (error, detail)
            self.status.pop(backend, None)

    def cancel(self):
        with self.lock:
            attempt = self.attempt
            if attempt is None:
                return self.public()
            attempt["cancelled"] = True
        _stop(attempt)
        return self.public()

    def _spawn(self, argv, env):
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                env=env, cwd=str(self.root / "run" / "workspace"), close_fds=True, **new_group_options())
        track_group(proc)
        with self.lock:
            self.attempt["proc"] = proc
            cancelled = self.attempt.get("cancelled")
        if cancelled:
            _stop(self.attempt)
        return proc

    def _codex(self, cli):
        proc = self._spawn([cli, "app-server", "--listen", "stdio://"], self._env("codex"))
        lines = _lines(proc)
        try:
            def call(ident, method, params):
                proc.stdin.write((json.dumps({"id": ident, "method": method, "params": params}) + "\n").encode())
                proc.stdin.flush()
                message = _next(lines, lambda m: m.get("id") == ident, 30)
                if "error" in message:
                    raise LoginFailed("login_rejected")
                return message["result"]
            call(1, "initialize", {"clientInfo": {"name": "endfield_personal_agent", "version": "1"}})
            proc.stdin.write(b'{"method": "initialized"}\n')
            started = call(2, "account/login/start", {"type": "chatgpt"})
            if not self.open_url(started["authUrl"]):
                raise LoginFailed("browser_unavailable")
            done = _next(lines, lambda m: m.get("method") == "account/login/completed", TIMEOUT)["params"]
            if not done.get("success"):
                raise LoginFailed("login_denied")
            account = call(3, "account/read", {}).get("account") or {}
            atomic_write_json(self.home("codex") / "account.json",
                              {"email": account.get("email"), "plan": account.get("planType")})
        finally:
            _stop({"proc": proc})

    def _claude(self, cli):
        # The unmodified CLI opens the browser and stores what it receives; it exits 0 once signed in.
        proc = self._spawn([cli, "auth", "login", "--claudeai"], self._env("claude"))
        self._wait(proc)

    def _acp(self, agent, method):
        if method.get("type") == "terminal":
            # The agent's own login: the user's profile directories stay.
            env = {**runner_environment(self.root / "run", auth_mode="existing_login"), **agent.get("env", {}), **method.get("env", {})}
            self._wait(self._spawn([*agent["command"], *method.get("args", [])], env))
        else:
            from character_agent.harness.acp_agents import authenticate
            with self.lock:
                cancel = self.attempt["cancel"] = threading.Event()
            refused = authenticate(agent["command"], agent.get("env"), method["id"], TIMEOUT, cancel)
            if refused is not None:
                raise LoginFailed("login_denied", refused or None)
        if self.on_acp_login:
            self.on_acp_login(agent["id"], True)

    def _wait(self, proc):
        lines = _lines(proc)
        try:
            _next(lines, lambda line: line is None, TIMEOUT, raw=True)
        finally:
            _stop({"proc": proc})
        if proc.wait() != 0:
            raise LoginFailed("login_denied")

    def logout(self, backend, cli=None, *, agent=None):
        if backend == "acp":
            from character_agent.harness.acp_agents import logout
            if not logout(agent["command"], agent.get("env")):
                raise ValueError("logout_unsupported")
            if self.on_acp_login:
                self.on_acp_login(agent["id"], False)
        else:
            argv = [cli, "logout"] if backend == "codex" else [cli, "auth", "logout"]
            try:
                subprocess.run(argv, env=self._env(backend), stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                               cwd=str(self.root / "run" / "workspace"))
            except subprocess.TimeoutExpired:
                raise ValueError("logout_failed") from None
            (self.home(backend) / "account.json").unlink(missing_ok=True)
        with self.lock:
            self.status.pop(backend, None)
        return self.public()


class LoginFailed(Exception):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def _stop(attempt):
    proc = attempt.get("proc")
    if attempt.get("cancel"):
        attempt["cancel"].set()
    if proc is None:
        return
    if proc.poll() is None:
        try:
            signal_group(proc, force=True)
        except ProcessLookupError:
            pass
    proc.wait()
    release_group(proc)


def _lines(proc):
    """A queue of `proc`'s output lines, then None at its end."""
    lines = queue.Queue()
    def read():
        for raw in proc.stdout:
            lines.put(raw)
        lines.put(None)
    threading.Thread(target=read, daemon=True).start()
    return lines


def _next(lines, wanted, timeout, raw=False):
    """The first line that `wanted` accepts: a JSON object, or with `raw` the bytes (None at the end of output)."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            line = lines.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            raise LoginFailed("login_timeout") from None
        if raw:
            if wanted(line):
                return line
            continue
        if line is None:
            raise LoginFailed("login_failed")
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message, dict) and wanted(message):
            return message
