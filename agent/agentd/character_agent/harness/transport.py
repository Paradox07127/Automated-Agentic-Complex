"""Synchronous agentd facade for its private asynchronous SDK runner.

Only one caller owns a stream. A separate reader handles tool requests and a
separate write lock lets interrupt bypass a tool waiting for native consent.
"""
import contextvars
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import queue
import secrets
import sqlite3
import subprocess
import threading
import time

from infra.platform import (child_environment, make_private_dir, new_group_options, release_group, signal_group,
                            track_group)

from .profile_cleanup import lock_runner_actor, release_runner_actor, remove_runner_actor

PROTOCOL_VERSION = 1
# Native image replies must fit the 32 MiB authorized capture payload plus IPC framing.
MAX_FRAME = 40 * 1024 * 1024
# C8 §10: every ready frame carries all of these keys, each with one of the listed values.
CAPABILITIES = {
    "cancel": ("native", "process_kill"),
    "tool_injection": ("in_process", "dynamic_tools", "mcp_stdio", "mcp_http"),
    "builtin_tools": ("disabled_verified", "unverified"),
    "system_prompt": ("native", "prompt_prefix"),
    "usage": ("usd", "tokens", "none"),
    "event_scope": ("session", "global"),
    "native_questions": (True, False),
}
# Development only: tools/dev/dev_console.py sets it to a JSONL file that gets every frame to and from the runners, with
# credentials redacted. Unset (the installed app), nothing is recorded.
FRAME_LOG = os.environ.get("AGENTD_FRAME_LOG")
# A recorded string longer than this keeps its start and its length: image replies run to megabytes.
FRAME_LOG_CHARS = 262144
# A frame log past this many bytes becomes FRAME_LOG + ".1", replacing the one before, and a new file starts.
FRAME_LOG_BYTES = 64 * 1024 * 1024
# Keys whose values a recorded frame replaces with "[redacted]", compared lower-case.
SECRET_KEYS = {"api_key", "apikey", "token", "access_token", "refresh_token", "id_token", "authorization", "password",
               "secret", "cookie"}
_frame_log_lock = threading.Lock()
_frame_log_failed = False
# Job actor directory -> the thread reaping its last runner; the actor's next runner waits for it.
_reaping = {}
_reapers = set()
_reaping_lock = threading.Lock()


def join_reapers():
    """Wait until every closed runner has exited and its directory is gone."""
    with _reaping_lock:
        pending = list(_reapers)
    for reaper in pending:
        reaper.join()


# The variable that points a kernel at its profile directory: the user's own, or Agentic Complex's with product_login.
NATIVE_HOME_VAR = {"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR"}


def runner_environment(state_dir, *, auth_mode="api_key"):
    """The user's environment (search path, proxies, provider settings) without Endfield's own variables."""
    root = Path(state_dir).resolve()
    for child in (root, root / "workspace", root / "tmp"):
        make_private_dir(child)
    platform = child_environment(root / "tmp")
    # AGENTD_HOOK_TOKEN, AAC_CODEX_API_KEY and the AAC_TTS_* tokens belong to Endfield, not to the harness.
    env = {key: value for key, value in os.environ.items() if not key.startswith(("AGENTD_", "AAC_"))}
    env.setdefault("PATH", platform["PATH"])
    env.update({key: value for key, value in platform.items() if key != "PATH"},
               HOME=str(Path.home()), LANG="en_US.UTF-8", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1",
               DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1", DISABLE_AUTOUPDATER="1")
    if auth_mode != "existing_login":
        # An Endfield key runs in the profile its runner sets up, not in the user's native one.
        for key in NATIVE_HOME_VAR.values():
            env.pop(key, None)
    return env


class HarnessError(RuntimeError):
    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code)


def redacted(value):
    if isinstance(value, dict):
        return {k: "[redacted]" if k.lower() in SECRET_KEYS and v else redacted(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redacted(v) for v in value]
    if isinstance(value, str) and len(value) > FRAME_LOG_CHARS:
        return f"{value[:FRAME_LOG_CHARS]}…[{len(value)} chars]"
    return value


def record_frame(direction, session, proc, message):
    """Appends one frame to FRAME_LOG: `direction` "out" (agentd to the runner) or "in". A failed write loses the record
    only; the caller's frame goes on as without FRAME_LOG."""
    global _frame_log_failed
    if FRAME_LOG is None:
        return
    backend = type(session).__name__.removeprefix("Managed").removesuffix("Session")
    line = json.dumps({"at": datetime.now().astimezone().isoformat(timespec="milliseconds"), "dir": direction,
                       "backend": backend, "pid": proc.pid, "frame": redacted(message)}, ensure_ascii=False) + "\n"
    try:
        with _frame_log_lock:
            if os.path.exists(FRAME_LOG) and os.path.getsize(FRAME_LOG) > FRAME_LOG_BYTES:
                os.replace(FRAME_LOG, FRAME_LOG + ".1")
            with open(FRAME_LOG, "a", encoding="utf-8") as f:
                f.write(line)
    except OSError as error:
        if not _frame_log_failed:
            _frame_log_failed = True
            logging.getLogger(__name__).warning("Frame log %s not written: %s", FRAME_LOG, error)


def cancelled_now(value):
    return bool(value and (value.is_set() if hasattr(value, "is_set") else value()))


def capabilities_valid(capabilities):
    # The type check keeps 0/1 out of native_questions: 1 == True.
    return isinstance(capabilities, dict) and all(
        key in capabilities and capabilities[key] in allowed and isinstance(capabilities[key], type(allowed[0]))
        for key, allowed in CAPABILITIES.items())


class ManagedClaudeSession:
    # Grace period for delivering an interrupt or exiting after close.
    CLOSE_WAIT = 1

    def __init__(self, config, tool_definitions=None, tool_handler=None, permission_handler=None, *, runner_path):
        self.config = config
        self.tool_definitions = list(tool_definitions or [])
        self.tool_handler = tool_handler
        self.permission_handler = permission_handler
        self.runner_path = Path(runner_path).resolve()
        self._proc = None
        self._runner_actor = None
        self._write_lock = threading.Lock()
        self._stream_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._events = queue.Queue(maxsize=512)
        self._active = None
        self._generation = 0
        self._system_prompt = None
        self._first_query = True
        self._ready = None
        self._tool_slots = threading.BoundedSemaphore(8)
        self._seen_tools = set()
        self._seen_permissions = set()
        self.session_id = None
        self.capabilities = None

    @property
    def pid(self):
        with self._state_lock:
            return self._proc.pid if self._proc is not None else None

    def _write(self, message, proc=None):
        raw = json.dumps({"v": PROTOCOL_VERSION, **message}, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        if len(raw) > MAX_FRAME:
            raise HarnessError("frame_too_large")
        with self._write_lock:
            selected = proc or self._proc
            if selected is None or selected.poll() is not None:
                raise HarnessError("runner_not_running")
            try:
                selected.stdin.write(raw)
                selected.stdin.flush()
            except (OSError, ValueError) as error:
                raise HarnessError("runner_disconnected") from error
        record_frame("out", self, selected, message)

    def _send_control(self, message, proc):
        def send():
            try:
                self._write(message, proc)
            except HarnessError as error:
                logging.getLogger(__name__).debug("Runner %s frame undelivered: %s", message["type"], error.code)
        writer = threading.Thread(target=send, name="character-runner-control", daemon=True)
        writer.start()
        return writer

    def _queue(self, event, generation):
        if generation != self._generation:
            return
        try:
            self._events.put(event, timeout=0.2)
        except queue.Full:
            self._terminate(self._proc)

    def _read(self, proc, generation):
        last_seq = 0
        try:
            while True:
                raw = proc.stdout.readline(MAX_FRAME + 1)
                if not raw:
                    break
                if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                    raise ValueError("oversized_frame")
                message = json.loads(raw)
                if not isinstance(message, dict) or message.get("v") != PROTOCOL_VERSION:
                    raise ValueError("invalid_protocol")
                seq = message.get("seq")
                if not isinstance(seq, int) or isinstance(seq, bool) or seq <= 0:
                    raise ValueError("invalid_sequence")
                if seq <= last_seq:
                    continue
                last_seq = seq
                record_frame("in", self, proc, message)
                if message.get("type") == "ready" and not capabilities_valid(message.get("capabilities")):
                    raise ValueError("invalid_protocol")
                if message.get("type") == "tool_request":
                    self._dispatch_tool(proc, generation, message)
                elif message.get("type") == "permission_request":
                    self._dispatch_permission(proc, generation, message)
                else:
                    self._queue(message, generation)
        except (ValueError, OSError, TypeError):
            self._queue({"type": "error", "code": "runner_protocol_error", "message": "Invalid harness response"}, generation)
            self._terminate(proc)
        finally:
            self._queue({"type": "eof"}, generation)

    def _dispatch_tool(self, proc, generation, message):
        call_id, run_id = message.get("tool_call_id"), message.get("run_id")
        with self._state_lock:
            active = self._active
            valid = active and active["id"] == run_id and not active["cancelled"] and generation == self._generation
            key = (run_id, call_id)
            if not isinstance(call_id, str) or not call_id or key in self._seen_tools:
                valid = False
            self._seen_tools.add(key)
        if not valid or not self._tool_slots.acquire(blocking=False):
            self._tool_result(proc, call_id, run_id, {"error": "run_cancelled_or_busy"}, True)
            return

        def work():
            fields = {key: message[key] for key in ('item_id', 'kind', 'phase', 'status', 'parent_item_id') if key in message}
            try:
                if cancelled_now(active["cancel_signal"]):
                    raise HarnessError("run_cancelled")
                name, args = message.get("name"), message.get("args")
                if name not in {t["name"] for t in self.tool_definitions} or not isinstance(args, dict):
                    raise HarnessError("unknown_tool")
                self._queue({"type": "tool_started", "run_id": run_id, "tool_call_id": call_id,
                             "name": name, "args": args, **fields}, generation)
                handler = active["handler"]
                if handler is None:
                    raise HarnessError("tool_unavailable")
                contextual = getattr(handler, "call_with_context", None)
                context = {"tool_call_id": call_id, "run_id": run_id}
                result = contextual(name, args, context) \
                    if contextual is not None else handler(name, args)
                # Domain services return JSON, optionally MCP image/content blocks.
                json.dumps(result, allow_nan=False)
                failed = isinstance(result, dict) and bool(result.get("isError") or result.get("error"))
            except Exception as error:
                code = getattr(error, "code", "tool_failed")
                if isinstance(error, ValueError) and str(error) == "interaction_pending": code = "interaction_pending"
                if code == 'tool_failed':
                    error_type = type(error).__name__
                    if isinstance(error, sqlite3.Error):
                        sqlite_name = getattr(error, 'sqlite_errorname', None)
                        if sqlite_name:
                            error_type += '/' + sqlite_name
                    logging.getLogger(__name__).warning('character tool %s failed: %s', message.get('name'), error_type)
                result, failed = {"error": code}, True
                if code == 'interaction_pending':
                    self._queue({'type': 'waiting_user', 'run_id': run_id}, generation)
            finally:
                self._tool_slots.release()
            self._queue({"type": "tool_finished", "run_id": run_id, "tool_call_id": call_id,
                         "name": message.get("name"), "result": result,
                         **({**fields, 'item_id': fields['item_id'] + ':result', 'kind': 'tool_result',
                             'status': 'completed', 'parent_item_id': fields['item_id']} if fields.get('item_id') else {})}, generation)
            with self._state_lock:
                current = self._active is active and not active["cancelled"] and generation == self._generation
            if not current or cancelled_now(active["cancel_signal"]):
                result, failed = {"error": "run_cancelled"}, True
            self._tool_result(proc, call_id, run_id, result, failed)

        threading.Thread(target=active["context"].copy().run, args=(work,), name="character-tool", daemon=True).start()

    def _dispatch_permission(self, proc, generation, message):
        request_id, run_id = message.get("request_id"), message.get("run_id")
        with self._state_lock:
            active = self._active
            valid = active and active["id"] == run_id and not active["cancelled"] and generation == self._generation
            key = (run_id, request_id)
            if not isinstance(request_id, str) or not request_id or key in self._seen_permissions:
                valid = False
            self._seen_permissions.add(key)
        if not valid or cancelled_now(active["cancel_signal"]):
            self._permission_result(proc, request_id, run_id, None)
            return
        request = {key: message.get(key) for key in
                   ("run_id", "request_id", "title", "kind", "locations", "raw_input", "options")}
        self._queue({"type": "permission_requested", **request}, generation)
        handler = active["permission_handler"]
        if handler is None:
            self._permission_result(proc, request_id, run_id, None)
            return

        def work():
            try:
                option_id = handler(request)
            except Exception:
                option_id = None
            with self._state_lock:
                current = self._active is active and not active["cancelled"] and generation == self._generation
            if not current or cancelled_now(active["cancel_signal"]) or not isinstance(option_id, str):
                option_id = None
            self._permission_result(proc, request_id, run_id, option_id)

        threading.Thread(target=active["context"].copy().run, args=(work,), name="character-permission", daemon=True).start()

    def _permission_result(self, proc, request_id, run_id, option_id):
        try:
            self._write({"type": "permission_result", "run_id": run_id, "request_id": request_id,
                         "option_id": option_id}, proc)
        except (HarnessError, ValueError, TypeError):
            pass

    def _tool_result(self, proc, call_id, run_id, result, failed):
        try:
            self._write({"type": "tool_result", "tool_call_id": call_id, "run_id": run_id,
                         "result": result, "is_error": failed}, proc)
        except (HarnessError, ValueError, TypeError):
            pass

    def _ensure(self, system_prompt):
        self.config.validate(require_key=False)
        if self._proc is not None and self._proc.poll() is None and self._system_prompt == system_prompt:
            return self._ready
        self.close()
        with _reaping_lock:
            pending = _reaping.get(Path(self.config.state_dir).absolute())
        if pending is not None:
            pending.join()
        with self._state_lock:
            self._generation += 1
            generation = self._generation
            self._events = queue.Queue(maxsize=512)
            self._seen_tools = set()
            self._seen_permissions = set()
            env = runner_environment(self.config.state_dir, auth_mode=getattr(self.config, "auth_mode", "api_key"))
            if getattr(self.config, "native_home", None):
                env[NATIVE_HOME_VAR[self.config.backend]] = self.config.native_home
            try:
                self._runner_actor = lock_runner_actor(self.config.state_dir)
                options = new_group_options()
                if self._runner_actor and self._runner_actor.dir_fds:
                    options["pass_fds"] = (self._runner_actor.lock,)
                self._proc = subprocess.Popen([self.config.python, "-I", "-B", "-X", "utf8", str(self.runner_path)],
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                              stderr=subprocess.DEVNULL, env=env, bufsize=0,
                                              close_fds=True, **options)
                track_group(self._proc)
            except OSError as error:
                release_runner_actor(self._runner_actor)
                self._runner_actor = None
                raise HarnessError("sdk_unavailable") from error
            proc = self._proc
            self._system_prompt = system_prompt
            self._first_query = True
            threading.Thread(target=self._read, args=(proc, generation), name="character-runner-reader", daemon=True).start()
        self._write({"type": "init", "config": self.config.wire(), "system_prompt": system_prompt,
                     "tools": self.tool_definitions})
        deadline = time.monotonic() + self.config.startup_timeout
        while time.monotonic() < deadline:
            try:
                event = self._events.get(timeout=min(0.1, max(0.001, deadline-time.monotonic())))
            except queue.Empty:
                continue
            if event["type"] == "ready":
                self._ready = event
                self.session_id = event.get("session_id")
                self.capabilities = event["capabilities"]
                return event
            if event["type"] in ("error", "eof"):
                self.close()
                raise HarnessError(event.get("code", "sdk_unavailable"), event.get("message"))
        self.close()
        raise HarnessError("sdk_startup_timeout")

    def probe(self, system_prompt="You are a personal assistant."):
        """Start and initialize the actual SDK; does not query a model."""
        with self._stream_lock:
            return dict(self._ensure(system_prompt))

    def stream(self, prompt, *, system_prompt, history=None, cancelled=None, run_id=None, tool_handler=None, ask_user_result=None,
               permission_handler=None, timeout=None, replace_history=False):
        """timeout: the caller's own limit in seconds; without one a run lasts until its result or a cancel."""
        self.config.validate()
        if not isinstance(prompt, str):
            raise ValueError("prompt_must_be_text")
        if replace_history:
            while not self._stream_lock.acquire(timeout=.05):
                if cancelled_now(cancelled):
                    raise HarnessError("cancelled")
        elif not self._stream_lock.acquire(blocking=False):
            raise HarnessError("run_busy")
        run_id = run_id or secrets.token_hex(12)
        started = False
        try:
            if cancelled_now(cancelled):
                yield {"type": "result", "success": False, "subtype": "cancelled", "run_id": run_id}
                return
            ready = self._ensure("", cancelled=cancelled) if replace_history else self._ensure(system_prompt)
            yield {**ready, "run_id": run_id, "session_id": self.session_id}
            deadline = None if timeout is None else time.monotonic() + timeout
            # Tool and permission work runs on reader-spawned threads; the caller's context carries its turn's trace.
            active = {"id": run_id, "handler": tool_handler or self.tool_handler, "cancel_signal": cancelled,
                      "permission_handler": permission_handler or self.permission_handler, "cancelled": False,
                      "context": contextvars.copy_context()}
            with self._state_lock:
                stop = cancelled_now(cancelled)
                if not stop:
                    self._active = active
            if stop:
                yield {"type": "result", "success": False, "subtype": "cancelled", "run_id": run_id}
                return
            self._write({"type": "query", "run_id": run_id, "prompt": prompt,
                         "history": history if replace_history or self._first_query else None,
                         **({"system_prompt": system_prompt, "max_output_tokens": 1024} if replace_history else {}),
                         **({"ask_user_result": ask_user_result} if ask_user_result else {})})
            self._first_query = False
            started = True
            interrupted_at = None
            while True:
                if cancelled_now(cancelled) or active["cancelled"]:
                    if interrupted_at is None:
                        interrupted_at = time.monotonic()
                        self.interrupt()
                    elif time.monotonic() - interrupted_at > 3:
                        self.close()
                        yield {"type": "result", "success": False, "subtype": "cancelled", "run_id": run_id}
                        return
                if deadline is not None and time.monotonic() > deadline:
                    self.interrupt()
                    self.close()
                    raise HarnessError("run_timeout")
                try:
                    event = self._events.get(timeout=0.05)
                except queue.Empty:
                    continue
                if event.get("run_id") not in (None, run_id):
                    continue
                if event["type"] == "eof":
                    raise HarnessError("runner_disconnected")
                if event["type"] == "error":
                    raise HarnessError(event.get("code", "sdk_error"), event.get("message"))
                if event["type"] == "result":
                    self.session_id = event.get("session_id", self.session_id)
                    if active["cancelled"] or cancelled_now(cancelled):
                        event = {**event, "success": False, "subtype": "cancelled"}
                    yield event
                    return
                if not active["cancelled"]:
                    yield event
        finally:
            with self._state_lock:
                if self._active and self._active["id"] == run_id:
                    self._active["cancelled"] = True
                    self._active = None
            # A consumer that closes a generator early must not leave its SDK
            # response in the receive queue for the next user's input.
            if started and 'event' in locals() and event.get("type") != "result":
                self.close()
            self._stream_lock.release()

    def interrupt(self):
        with self._state_lock:
            active, proc = self._active, self._proc
            if not active or active["cancelled"] or proc is None:
                return
            active["cancelled"] = True
            writer = self._send_control({"type": "interrupt", "run_id": active["id"]}, proc)

        def reap_if_blocked():
            writer.join(self.CLOSE_WAIT)
            with self._state_lock:
                if writer.is_alive() and self._proc is proc and self._active is active:
                    self.close()
        threading.Thread(target=reap_if_blocked, name="character-interrupt-deadline", daemon=True).start()

    def invalidate(self):
        self.close()

    @staticmethod
    def _terminate(proc):
        if proc is None:
            return
        try:
            try:
                signal_group(proc)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    signal_group(proc, force=True)
                except (ProcessLookupError, PermissionError):
                    pass
                proc.wait(timeout=2)
        finally:
            release_group(proc)

    def _reap(self, proc, lease, actor):
        try:
            try:
                proc.wait(timeout=self.CLOSE_WAIT)
            except subprocess.TimeoutExpired:
                pass
            # Also remove a CLI descendant left behind after a runner exited.
            self._terminate(proc)
            for handle in (proc.stdin, proc.stdout):
                if handle is not None:
                    handle.close()
            try:
                remove_runner_actor(self.config.state_dir, lease)
            finally:
                release_runner_actor(lease)
        finally:
            with _reaping_lock:
                _reapers.discard(threading.current_thread())
                if _reaping.get(actor) is threading.current_thread():
                    del _reaping[actor]

    def close(self):
        """Send the runner its close frame and reap it on a separate thread; the caller does not wait."""
        with self._state_lock:
            proc, self._proc = self._proc, None
            lease, self._runner_actor = self._runner_actor, None
            if self._active:
                self._active["cancelled"] = True
            self._ready = None
            self.session_id = None
            if proc is not None:
                actor = Path(self.config.state_dir).absolute()
                reaper = threading.Thread(target=self._reap, args=(proc, lease, actor), name="character-runner-reaper")
                with _reaping_lock:
                    _reapers.add(reaper)
                    if lease is not None:
                        _reaping[actor] = reaper
                reaper.start()
                self._send_control({"type": "close"}, proc)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
