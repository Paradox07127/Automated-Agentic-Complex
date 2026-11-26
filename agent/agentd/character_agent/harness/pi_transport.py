"""Pi's Node SDK behind Endfield's existing private stream/tool IPC contract."""
import json
from pathlib import Path
import queue
import re
import secrets
import subprocess
import threading
import time

from infra.platform import new_group_options, release_group, signal_group, track_group

from .codex_runner import classify_failure
from .pi_config import PiConfig, pi_runner_environment
from .transport import MAX_FRAME, HarnessError, ManagedClaudeSession, cancelled_now

RUNNER = Path(__file__).with_name("pi_runner.mjs")
# pi_runner's result subtype when a run stops at config max_budget_usd or max_turns -> its failure code.
PI_LIMITS = {"max_budget": "budget_limit", "max_turns": "turn_limit"}


def list_models(node, runtime_dir, state_dir, provider, timeout=30.0):
    """Pi's offline catalog from a runner of its own: {providers, models of `provider`}; no key, no network.
    `provider` None lists only the providers."""
    env = pi_runner_environment(state_dir)
    try:
        proc = subprocess.Popen([node, str(RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=str(Path(state_dir).resolve() / "workspace"), env=env,
            bufsize=0, close_fds=True, **new_group_options())
        track_group(proc)
    except OSError as error:
        raise ValueError("pi_runtime_unavailable") from error
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(proc.stdout.readline(MAX_FRAME + 1)), name="pi-catalog-reader",
                     daemon=True).start()
    try:
        # stdin stays open until the answer: the runner exits when it closes.
        proc.stdin.write((json.dumps({"v": 1, "type": "list_models", "runtime_dir": runtime_dir,
                                      "provider": provider}) + "\n").encode())
        proc.stdin.flush()
        raw = lines.get(timeout=timeout)
    except OSError:
        raw = b""
    except queue.Empty:
        raise ValueError("sdk_startup_timeout") from None
    finally:
        try:
            try:
                proc.stdin.close()
                proc.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    signal_group(proc, force=True)
                except (ProcessLookupError, PermissionError):
                    pass
                proc.wait()
        finally:
            release_group(proc)
            proc.stdout.close()
    try:
        frame = json.loads(raw) if raw else {"code": "pi_runtime_unavailable"}
    except ValueError:
        frame = None
    if not isinstance(frame, dict):
        raise ValueError("pi_runner_error")
    if frame.get("type") != "models":
        raise ValueError(frame.get("code") or "pi_runner_error")
    return {"providers": frame["providers"], "models": frame["models"]}


class ManagedPiSession(ManagedClaudeSession):
    """Share process lifecycle/IPC, but never create a Claude session or loop."""
    def __init__(self, config: PiConfig, tool_definitions=None, tool_handler=None, permission_handler=None, *,
                 runner_path=None, credential=None, on_ready=None, service_ready=None):
        super().__init__(config, tool_definitions, tool_handler, permission_handler,
                         runner_path=runner_path or RUNNER)
        # () -> the connection's current key, sent with every query.
        self.credential = credential
        # (ready frame) -> None, each time a runner starts.
        self.on_ready = on_ready
        # (cancelled=, timeout=) -> whether the compatible API can take a query, asked before each one (it may start
        # the API).
        self.service_ready = service_ready

    def prewarm(self):
        """Start the runner without its init: it loads Pi's SDK meanwhile, and the first query's init (which needs that
        query's system prompt and tools) only builds the session. A runner already running, or a run, is warm already."""
        if not self._stream_lock.acquire(blocking=False):
            return
        try:
            self.config.validate(require_key=False)
            with self._state_lock:
                if self._proc is not None and self._proc.poll() is None:
                    return
            self.close()
            self._spawn(None)
        finally:
            self._stream_lock.release()

    def _queue(self, event, generation, proc):
        # The model's own error text is classified here and goes no further: it may quote request content.
        if event.get("type") == "result" and "error_message" in event:
            event = dict(event)
            text = event.pop("error_message")
            if event.get("stop_reason") == "length":
                # A retry hits the same output limit.
                event.update(error="output_truncated", failure={"code": "output_truncated", "retryable": False})
            elif event.get("subtype") in PI_LIMITS:
                # The run reached the user's own limit, not the provider's quota.
                event.update(error=event["subtype"], failure={"code": PI_LIMITS[event["subtype"]], "retryable": False})
            elif event.get("subtype") != "cancelled":
                # pi-ai writes an HTTP failure as "<status>: <body>".
                status = re.match(r"(\d{3}):", text)
                event.update(error=event.get("subtype"), failure=classify_failure(
                    event.get("subtype"), errors=[text], status=int(status.group(1)) if status else None))
        super()._queue(event, generation, proc)

    def stream(self, prompt, *, cancelled=None, run_id=None, timeout=None, **options):
        run_id = run_id or secrets.token_hex(12)
        if self.service_ready is not None:
            # Before the stream lock: a start can take minutes, and a cancel or the caller's timeout ends the wait.
            started = time.monotonic()
            ready = self.service_ready(cancelled=lambda: cancelled_now(cancelled), timeout=timeout)
            if cancelled_now(cancelled):
                yield {"type": "result", "success": False, "subtype": "cancelled", "run_id": run_id}
                return
            if timeout is not None:
                timeout -= time.monotonic() - started
            if not ready:
                raise HarnessError("run_timeout" if timeout is not None and timeout <= 0 else "llm_ensure_failed")
        yield from super().stream(prompt, cancelled=cancelled, run_id=run_id, timeout=timeout, **options)

    def _write(self, message, proc=None):
        if message["type"] == "query" and self.credential is not None:
            try:
                message = {**message, "api_key": self.credential()}
            except ValueError as error:
                raise HarnessError(str(error)) from None
        super()._write(message, proc)

    def _spawn(self, system_prompt):
        """A new runner for this session; system_prompt None marks one prewarm started, which awaits its init."""
        with self._state_lock:
            self._generation += 1
            generation = self._generation
            self._events = queue.Queue(maxsize=512)
            self._seen_tools = set()
            try:
                env = pi_runner_environment(self.config.state_dir)
                # The runtime directory lets the runner import the SDK before its init arrives.
                self._proc = subprocess.Popen([self.config.node, str(self.runner_path), str(self.config.runtime_dir)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    cwd=str(Path(self.config.state_dir).resolve() / "workspace"), env=env,
                    bufsize=0, close_fds=True, **new_group_options())
                track_group(self._proc)
            except OSError as error:
                raise HarnessError("pi_runtime_unavailable") from error
            self._system_prompt = system_prompt
            self._first_query = True
            threading.Thread(target=self._read, args=(self._proc, generation), name="pi-runner-reader",
                             daemon=True).start()
            return self._proc

    def _ensure(self, system_prompt, cancelled=None):
        self.config.validate(require_key=False)
        with self._state_lock:
            running = self._proc is not None and self._proc.poll() is None
            if running and self._system_prompt == system_prompt and self._ready is not None:
                return self._ready
            spare = self._proc if running and self._ready is None and self._system_prompt is None else None
            if spare is not None:
                self._system_prompt = system_prompt
        if spare is not None:
            proc = spare
        else:
            self.close()
            proc = self._spawn(system_prompt)
        # Until its ready frame is published the runner is provisional: any failure closes it.
        try:
            self._write({"type": "init", "config": self.config.wire(), "system_prompt": system_prompt,
                         "tools": self.tool_definitions})
            deadline = time.monotonic() + self.config.startup_timeout
            while time.monotonic() < deadline:
                if cancelled_now(cancelled):
                    raise HarnessError("cancelled")
                try:
                    event = self._events.get(timeout=min(.1, max(.001, deadline-time.monotonic())))
                except queue.Empty:
                    continue
                if event["type"] == "ready":
                    with self._state_lock:
                        # A close() during the wait has already let this runner go.
                        if self._proc is not proc:
                            raise HarnessError("runner_not_running")
                        self._ready = event
                        self.session_id = event.get("session_id")
                        self.capabilities = event["capabilities"]
                    if self.on_ready is not None:
                        self.on_ready(event)
                    return event
                if event["type"] in ("error", "eof"):
                    raise HarnessError(event.get("code", "pi_runtime_unavailable"))
            raise HarnessError("sdk_startup_timeout")
        except BaseException:
            self.close()
            raise
