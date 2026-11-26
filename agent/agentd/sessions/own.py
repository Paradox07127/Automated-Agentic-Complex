"""Own sessions:agentd-driven Claude and Codex conversations.

Claude: a long-running `claude -p` with stream-json in and out; its PermissionRequest hook points at agentd,
so approvals use the same cards as external sessions. Codex: `codex app-server` JSON-RPC over stdio; agentd
is the client and answers its approval requests from the cards."""
from collections import deque
import contextlib
import itertools
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import threading
import time

from sessions.events import command_text, tool_summary
from infra.platform import new_group_options, release_group, signal_group, track_group
from infra.tokens import write_secret
from tool_gateway.computer_use import ComputerUseError, SERVER_NAME, validate as validate_desktop
from sessions.lifecycle import SessionCancelled, SessionRun
from tool_gateway import desktop
from tool_gateway.ledger import EffectLedger, ledger_path
from tool_gateway.policy import POLICY

# Child processes use the user's own CLI login; agentd's key and hook token never reach them.
SCRUBBED_ENV = ("ANTHROPIC_API_KEY", "AGENTD_HOOK_TOKEN")
DETAIL_MAX = 4000
LINE_MAX = 200
TITLE_MAX = 80
LINES_KEPT = 500
IDLE_AFTER = 600.0
HOOK_EVENTS = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
               "PermissionRequest", "Notification", "SubagentStop", "Stop", "StopFailure", "SessionEnd")
# own_sessions columns, in OwnSession.restore's argument order.
COLUMNS = ("session_id", "origin", "target", "cwd", "title", "native_id", "state", "last_line", "started_at",
           "updated_at", "mode", "seq")
# Permission modes a session may start in: the Claude --permission-mode and the Codex sandbox each one means.
MODES = {"read_only": {"claude": "default", "codex": "read-only"},
         "workspace_write": {"claude": "acceptEdits", "codex": "workspace-write"}}
# Claude tools each mode always sends to a card: an ask rule outranks the allow rules of the user's and the checkout's
# settings, which --settings only adds to.
CLAUDE_ASK = {"read_only": ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"], "workspace_write": ["Bash"]}
LIVE_STATES = ("thinking", "running_tool", "awaiting_approval")  # a turn cut off by a restart in these ends as error
CODEX_LOCK = Path(__file__).resolve().parent / "codex-protocol.lock.json"
# The declining reply to each Codex server request agentd answers; any other request gets an error reply.
DECLINES = {"item/commandExecution/requestApproval": {"decision": "decline"},
            "item/fileChange/requestApproval": {"decision": "decline"},
            "item/permissions/requestApproval": {"permissions": {}, "scope": "turn"},
            "mcpServer/elicitation/request": {"action": "decline", "content": None}}
# Transcript error lines and announcement headlines by reply language code; "harness" (None) takes the Chinese ones.
TEXT = {
    "zh-Hans": {"turn_failed": "codex 回合启动失败（{error}）", "start_failed": "{target} 启动失败（{error}）",
                "dispatch_failed": "{target} 的任务失败了", "session_failed": "{target} 的会话出错了",
                "succeeded": "{target} 的任务完成了，验证通过", "failed": "{target} 的任务验证没过",
                "needs_review": "{target} 回话了，结果待你确认"},
    "en": {"turn_failed": "codex turn failed to start ({error})", "start_failed": "{target} failed to start ({error})",
           "dispatch_failed": "{target}'s task failed", "session_failed": "{target}'s session hit an error",
           "succeeded": "{target}'s task is done and passed verification",
           "failed": "{target}'s task did not pass verification",
           "needs_review": "{target} replied; the result needs your review"},
    "ja": {"turn_failed": "codex のターンを開始できませんでした（{error}）", "start_failed": "{target} を起動できませんでした（{error}）",
           "dispatch_failed": "{target} のタスクが失敗しました", "session_failed": "{target} のセッションでエラーが起きました",
           "succeeded": "{target} のタスクが完了し、検証を通りました", "failed": "{target} のタスクは検証を通りませんでした",
           "needs_review": "{target} から返事がありました。結果を確認してください"}}

log = logging.getLogger(__name__)


def codex_version(executable):
    """The version `codex --version` prints, or None when it cannot be read."""
    try:
        out = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5,
                             check=True, encoding="utf-8").stdout.split()
    except (OSError, subprocess.SubprocessError):
        return None
    return out[-1] if out else None


def child_env(env=None):
    return {k: v for k, v in (os.environ if env is None else env).items() if k not in SCRUBBED_ENV}


def real_argv(target, settings=None, resume=None, mode="read_only"):
    if target == "codex":
        return ["codex", "app-server"]
    return ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", MODES[mode]["claude"], "--settings", settings] + (
        ["--resume", resume] if resume else [])


class OwnSession:
    def __init__(self, target, cwd, prompt, mode="read_only"):
        self.session_id = f"own:{secrets.token_hex(6)}"
        self.target, self.cwd, self.mode = target, cwd, mode
        self.title = prompt.strip().splitlines()[0][:TITLE_MAX]
        self.lines, self.seq = deque(maxlen=LINES_KEPT), 0
        self.state, self.last_line, self.text = "idle", None, ""
        self.started_at = self.updated_at = time.time()
        self.busy, self.backend, self.native_id, self.resumes = False, None, None, 0
        self.idle_since = time.monotonic()
        self.origin = None  # request_id of the dispatch card that started it
        self.dispatch_turn = False  # the turn that card started is still to end; its end is the dispatch's result
        self.cancel_requested = False  # interrupt sent, the backend has not ended the turn yet
        self.run = None  # the current turn's lease, including CLI startup
        self.pinned, self.archived, self.revision = False, False, 1

    @classmethod
    def restore(cls, session_id, origin, target, cwd, title, native_id, state, last_line, started_at, updated_at,
                mode, seq):
        """A session from its own_sessions row; without a process, so its next message resumes it."""
        session = cls(target, cwd, title, mode)
        session.session_id, session.origin, session.title, session.native_id = session_id, origin, title, native_id
        # Companion's cursor counts on from this seq; SessionManager reads the stored lines back.
        session.state, session.last_line, session.seq = state, last_line, seq
        session.started_at, session.updated_at = started_at, updated_at
        return session

    def to_dict(self):
        return {"session_id": self.session_id, "own": True, "target": self.target, "cwd": self.cwd,
                "title": self.title, "state": self.state, "last_line": self.last_line,
                "started_at": self.started_at, "updated_at": self.updated_at, "origin": None, "task_id": self.origin,
                "mode": self.mode,
                "pinned": self.pinned, "archived": self.archived, "revision": self.revision,
                "cancel_requested": self.cancel_requested, "capabilities": ["observe", "resume", "control"]}


class _Process:
    """One child process with a line reader; subclasses speak its protocol."""

    def __init__(self, manager, session, argv):
        self.manager, self.session = manager, session
        run = session.run
        # Its own process group, so stop() also reaches what the CLI starts.
        self.proc = subprocess.Popen(argv, cwd=session.cwd, env=child_env(), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                     encoding="utf-8", errors="replace", **new_group_options())
        self.write_lock = threading.Lock()
        self.stop_lock = threading.Lock()
        self.released = False  # the group was stopped and its handle released; stop() has nothing left to do
        try:
            track_group(self.proc)
            threading.Thread(target=self._read, daemon=True).start()
        except BaseException:
            self.proc.kill()
            self.proc.wait()
            release_group(self.proc)
            raise
        if not manager.register_backend(session, run, self):
            self.stop(0)
            raise SessionCancelled()

    def alive(self):
        return self.proc.poll() is None

    def write(self, obj):
        with self.write_lock:
            self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                try:
                    self.handle(message)
                except sqlite3.Error:  # the transcript cannot be kept: the finally below stops the process
                    log.exception("own session %s: transcript not stored", self.session.session_id)
                    break
                except Exception:
                    log.exception("own session %s: message not handled", self.session.session_id)
        finally:
            self.proc.stdout.close()
            with self.write_lock:
                try:
                    self.proc.stdin.close()
                except OSError:  # flushing what the gone child never read
                    pass
            try:
                self.stop(0)  # what the CLI started and left running
            except OSError as error:
                log.warning("own session %s: process group not stopped: %s", self.session.session_id, error)
            self.manager.exited(self.session, self)

    def stop(self, timeout=5.0):
        """SIGTERM to the child's process group; SIGKILL to what is left of it after timeout."""
        with self.stop_lock:
            self._stop_process(timeout)

    def _stop_process(self, timeout):
        if self.released:
            return
        # The group is signalled even when its leader has exited: what the CLI started can outlive it.
        try:
            signal_group(self.proc)
            try:
                self.proc.wait(max(0.0, timeout))
            except subprocess.TimeoutExpired:
                pass
            signal_group(self.proc, force=True)
        except ProcessLookupError:
            pass
        except PermissionError:
            try:
                self.proc.wait(1.0)  # Darwin answers EPERM while the group's leader is still exiting
            except subprocess.TimeoutExpired:
                pass
            if self.alive():
                raise
            try:
                signal_group(self.proc, force=True)  # the rest of the group, now that its leader is reaped
            except (ProcessLookupError, PermissionError):  # Darwin's EPERM again: only exiting members are left
                pass
        self.proc.wait()
        self.released = True
        release_group(self.proc)


class ClaudeProcess(_Process):
    def __init__(self, manager, session):
        super().__init__(manager, session, manager.process_argv(session, manager.argv(
            "claude", str(manager.settings_paths[session.mode]), session.native_id, mode=session.mode)))

    def send(self, text):
        self.write({"type": "user", "message": {"role": "user", "content": text}})

    def interrupt(self):
        self.write({"type": "control_request", "request_id": secrets.token_hex(4),
                    "request": {"subtype": "interrupt"}})

    def handle(self, event):
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            self.manager.set_native_id(self.session, event.get("session_id"))
        elif kind == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text"):
                    self.manager.add_line(self.session, "agent", block["text"])
                    self.manager.progress(self.session, "thinking", block["text"])
                elif block.get("type") == "tool_use":
                    self.manager.add_line(self.session, "tool",
                                          f"{block.get('name')}: {tool_summary(block.get('input'))}")
                    self.manager.progress(self.session, "running_tool", None)
        elif kind == "result":
            # An interrupted turn still reports subtype success; only terminal_reason tells them apart.
            if event.get("terminal_reason") == "aborted_streaming":
                status = "interrupted"
            else:
                status = "failed" if event.get("is_error") else "completed"
            self.manager.turn_ended(self.session, status, event.get("result"), backend=self)


class CodexProcess(_Process):
    def __init__(self, manager, session):
        self.ids = itertools.count(1)
        self.pending = {}
        self.turn_id = None
        self.interrupt_pending = False
        self.turn_lock = threading.Lock()
        self.changes = {}  # fileChange item id -> its changes, for that item's approval card
        super().__init__(manager, session, manager.process_argv(session, manager.argv("codex")))
        try:
            self.call("initialize", {"clientInfo": {"name": "agentd", "version": "1"}})
            self.write({"method": "initialized"})
            # The approval policy and reviewer stay as the user's config.toml sets them.
            policy = {"sandbox": MODES[session.mode]["codex"]}
            if session.native_id:
                result = self.call("thread/resume", {"threadId": session.native_id, **policy})
            else:
                result = self.call("thread/start", {"cwd": session.cwd, **policy})
            manager.set_native_id(session, result["thread"]["id"])
        except Exception:
            self.stop()
            raise

    def call(self, method, params, timeout=30, *, run=None):
        request_id, done = next(self.ids), threading.Event()
        self.pending[request_id] = [done, None]
        try:
            # Only the wire write is serialized with stop, never the handshake wait.
            with self.manager.lock:
                current = self.session.run
                if (run is not None and not self.manager.run_current(self.session, run)) or \
                        (method in ("initialize", "thread/start", "thread/resume") and
                         current is not None and current.cancelled.is_set()):
                    raise SessionCancelled()
                self.write({"id": request_id, "method": method, "params": params})
            deadline = time.monotonic() + timeout
            while not done.wait(min(0.05, max(0.0, deadline - time.monotonic()))):
                if method != "turn/interrupt" and self.session.run is not None and self.session.run.cancelled.is_set():
                    raise SessionCancelled()
                if not self.alive():
                    raise OSError("session process exited")
                if time.monotonic() >= deadline:
                    raise TimeoutError(method)
            reply = self.pending[request_id][1]
        finally:
            self.pending.pop(request_id, None)
        if "error" in reply:
            raise RuntimeError(reply["error"].get("message", method))
        return reply.get("result") or {}

    def send(self, text):
        self.session.text = ""
        threading.Thread(target=self._start_turn, args=(text, self.session.run), daemon=True).start()

    def _start_turn(self, text, run):
        try:
            self.call("turn/start", {"threadId": self.session.native_id, "input": [{"type": "text", "text": text}]}, run=run)
        except SessionCancelled:
            self.manager.turn_ended(self.session, "interrupted", None, backend=self, run=run)
        except Exception as e:  # rejected or unanswered: no turn/completed will free the session
            self.manager.add_line(self.session, "error", self.manager.text("turn_failed", error=type(e).__name__))
            self.manager.turn_ended(self.session, "failed", None, backend=self, run=run)

    def interrupt(self):
        with self.turn_lock:
            if not self.turn_id:
                # Before turn/started there is no turn to name; send it when one arrives.
                self.interrupt_pending = True
                return
            turn_id = self.turn_id
        threading.Thread(target=self._interrupt_turn, args=(turn_id,), daemon=True).start()

    def _interrupt_turn(self, turn_id):
        try:
            self.call("turn/interrupt", {"threadId": self.session.native_id, "turnId": turn_id})
        except (SessionCancelled, OSError, RuntimeError, TimeoutError):
            pass  # shutdown may close the transport before the interrupt acknowledgement

    def handle(self, message):
        method, params = message.get("method"), message.get("params") or {}
        if method is None:
            slot = self.pending.get(message.get("id"))
            if slot is not None:
                slot[1] = message
                slot[0].set()
        elif "id" in message:
            # The turn it was asked in: a card or an accept once that turn has ended would answer a stale request.
            threading.Thread(target=self._approval, args=(message, self.session.run), daemon=True).start()
        elif method == "turn/started":
            with self.turn_lock:
                self.turn_id = params["turn"]["id"]
                interrupt, self.interrupt_pending = self.interrupt_pending, False
            if interrupt:
                self.interrupt()
        elif method == "item/agentMessage/delta":
            self.session.text += params.get("delta", "")
            self.manager.progress(self.session, "thinking", self.session.text)
        elif method == "item/started" and params.get("item", {}).get("type") in ("commandExecution", "fileChange", "mcpToolCall"):
            item = params["item"]
            if item["type"] == "fileChange":
                self.changes[item.get("id")] = item.get("changes") or []
            self.manager.add_line(self.session, "tool", item.get("command") or
                                  (f"{item.get('server')}/{item.get('tool')}" if item["type"] == "mcpToolCall" else item["type"]))
            self.manager.progress(self.session, "running_tool", None)
        elif method == "item/completed" and params.get("item", {}).get("type") == "agentMessage":
            self.session.text = params["item"].get("text") or self.session.text
            if params["item"].get("text"):
                self.manager.add_line(self.session, "agent", params["item"]["text"])
        elif method == "turn/completed":
            with self.turn_lock:
                if self.turn_id and params["turn"].get("id") != self.turn_id:
                    return  # an older turn's late completion
                self.turn_id, self.interrupt_pending = None, False
            self.changes.clear()
            status = params["turn"].get("status")
            self.manager.turn_ended(self.session, status, self.session.text if status == "completed" else None,
                                    backend=self)
            # Cards still open belong to the finished turn; their waiting replies go back as decline. After the end,
            # which keeps a later request of that turn from opening one.
            self.manager.broker.cancel_session(self.session.target, self.session.session_id)

    def _approval(self, message, run):
        try:
            self._answer(message, run)
        except Exception:  # a request it cannot read is declined, never left unanswered
            log.exception("own session %s: approval request not answered", self.session.session_id)
            self._decline(message)

    def _answer(self, message, run):
        method, params = message["method"], message.get("params") or {}
        if method == "mcpServer/elicitation/request" and self.manager.computer_control is not None:
            meta = params.get("_meta") or {}
            meta = meta if isinstance(meta, dict) else {}
            # Codex 0.163 generated MCP tool approval form; arbitrary forms, URLs and other servers stay closed.
            scoped = params.get("serverName") == SERVER_NAME and params.get("threadId") == self.session.native_id \
                and params.get("mode") == "form" and meta.get("codex_approval_kind") == "mcp_tool_call" \
                and params.get("requestedSchema") == {"type": "object", "properties": {}}
            if scoped:
                # The native panel is the per-window consent authority. Avoid a second card
                # for a well-formed desktop action only when that same task has a native
                # window grant. The native executor still requires control and waits for
                # Continue when paused; it never replays an effect.
                tool_params, status = meta.get("tool_params"), None
                if self.session.mode == "workspace_write" and isinstance(tool_params, dict):
                    try:
                        validate_desktop("desktop_act", tool_params)
                        status = desktop.status(self.manager.computer_control, self.session.session_id)
                    except (ComputerUseError, ValueError, TypeError):
                        pass
                verdict = POLICY.desktop_elicitation(self.session.mode, tool_params, status)
                self.manager.verdict(self.session, "desktop_act", verdict)
                if verdict.method == "native_panel":
                    accepted = self._current(run)
                    try:
                        self.write({"id": message["id"],
                                    "result": {"action": "accept" if accepted else "decline", "content": {}}})
                    except (OSError, ValueError):
                        pass
                    return
                summary = str(params.get("message") or "Desktop tool request")
                if isinstance(meta.get("tool_params"), dict):
                    summary += "\n" + json.dumps(meta["tool_params"], ensure_ascii=False)
                decision = self.manager.ask(self.session, "desktop_control", summary, run=run)
                current = self._current(run)
                try:
                    self.write({"id": message["id"], "result": {
                        "action": "accept" if decision == "allow" and current else "decline", "content": {}}})
                except (OSError, ValueError):  # the process is gone; its exit ends the turn
                    return
                if current:
                    self.manager.progress(self.session, "running_tool", None)
                return
        if method == "mcpServer/elicitation/request" and not (
                self.manager.computer_control is not None and params.get("serverName") == SERVER_NAME):
            schema = params.get("requestedSchema")
            if params.get("mode") != "url" and isinstance(schema, dict) and schema.get("properties"):
                return self._decline(message)  # a card cannot fill in a form's fields
            summary = "\n".join(str(params[key]) for key in ("serverName", "message", "url") if params.get(key))
            return self._card(message, run, "elicitation", summary, lambda allowed: {
                "action": "accept", "content": None if params.get("mode") == "url" else {}} if allowed else
                {"action": "decline", "content": None})
        if method == "item/permissions/requestApproval":
            permissions = params.get("permissions") or {}
            shown = json.dumps(permissions, ensure_ascii=False)
            if len(shown) > DETAIL_MAX:
                return self._decline(message)  # allowing it would grant what the card cannot show
            summary = "\n".join(filter(None, (shown, params.get("reason"))))
            return self._card(message, run, "permissions", summary,
                              lambda allowed: {"permissions": permissions if allowed else {}, "scope": "turn"})
        if method not in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
            # Unknown server requests fail closed.
            return self.write({"id": message["id"], "error": {"code": -32601, "message": "unsupported"}})
        tool = "command" if "commandExecution" in method else "fileChange"
        command = command_text(params)  # an argv list joined into one string
        summary = command or params.get("command") or params.get("reason") or tool
        # The request carries no change set; the item/started before it does.
        changes = self.changes.get(params.get("itemId")) if tool == "fileChange" else None
        scope = targets = None
        if tool == "command" and command is not None:
            targets = [command]
        if changes:
            if not all(isinstance(c, dict) and isinstance(c.get("path"), str) and isinstance(c.get("diff"), str)
                       and isinstance(c.get("kind"), dict) and isinstance(c["kind"].get("type"), str) for c in changes):
                raise ValueError("malformed fileChange changes")
            summary = "\n\n".join(f"{c['kind']['type']} {c['path']}\n{c['diff']}" for c in changes)
            targets = [p for c in changes for p in (c["path"], c["kind"].get("move_path")) if isinstance(p, str)]
            # Codex offers acceptForSession (later changes to the same files) for file changes only; without the
            # change set the files cannot be judged, so the card stays single approval.
            scope = {"kind": "same_files", "detail": "\n".join(c["path"] for c in changes), "updates": None}
        decision = self.manager.ask(self.session, tool, summary, session_scope=scope, targets=targets, run=run)
        current = self._current(run)
        reply = {"allow": "accept", "allow_session": "acceptForSession"}.get(decision, "decline") if current \
            else "decline"
        try:
            self.write({"id": message["id"], "result": {"decision": reply}})
        except (OSError, ValueError):  # the process is gone; its exit ends the turn
            return
        if current:
            self.manager.progress(self.session, "running_tool", None)

    def _card(self, message, run, tool, summary, result):
        """A single-approval card; result(allowed) is the reply to Codex."""
        decision = self.manager.ask(self.session, tool, summary, run=run)
        current = self._current(run)
        try:
            self.write({"id": message["id"], "result": result(decision == "allow" and current)})
        except (OSError, ValueError):  # the process is gone; its exit ends the turn
            return
        if current:
            self.manager.progress(self.session, "running_tool", None)

    def _current(self, run):
        with self.manager.lock:
            return self.manager.run_current(self.session, run)

    def _decline(self, message):
        decline = DECLINES.get(message["method"])
        try:
            self.write({"id": message["id"], **({"result": decline} if decline is not None else
                                                {"error": {"code": -32601, "message": "unsupported"}})})
        except (OSError, ValueError):  # the process is gone; its exit ends the turn
            pass


class SessionManager:
    def __init__(self, broker, announce, state_dir, hook_url, hook_token, hook_timeout,
                 argv=real_argv, idle_after=IDLE_AFTER, store=None, computer_control=None, reply_language=lambda: None):
        """reply_language() -> the reply language's code, or None for the Chinese text."""
        self.broker, self.announce, self.argv, self.idle_after = broker, announce, argv, idle_after
        self.reply_language = reply_language
        self.computer_control = computer_control
        self.sessions, self.lock, self.store = {}, threading.RLock(), store
        self.tasks = None  # TaskLedger the dispatched sessions' tasks are in; None keeps no task rows
        self.codex_checked = False
        self.closed = False  # close() has begun
        self.resetting = False  # stop_all() has begun and not yet forgotten the sessions
        # Absolute: claude runs with the project as cwd, where a relative --settings would not resolve.
        self.state_dir = state_dir.resolve()
        self.settings_paths = {mode: self.state_dir / f"own-claude-settings-{mode}.json" for mode in MODES}
        self.ledger = ledger_path(self.state_dir)
        hook = {"type": "http", "url": hook_url.rstrip("/") + "/hook/claude", "timeout": 3,
                "headers": {"Authorization": f"Bearer {hook_token}"}}
        hooks = {name: [{"hooks": [{**hook, "timeout": hook_timeout} if name == "PermissionRequest" else hook]}]
                 for name in HOOK_EVENTS}
        for mode, path in self.settings_paths.items():
            write_secret(path, json.dumps({"permissions": {"ask": CLAUDE_ASK[mode]}, "hooks": hooks}, indent=2))
        if store is not None:
            store.execute("CREATE TABLE IF NOT EXISTS session_management (session_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL, revision INTEGER NOT NULL)")
            for row in store.execute(f"SELECT {', '.join(COLUMNS)} FROM own_sessions").fetchall():
                session = OwnSession.restore(*row)
                metadata = store.execute("SELECT pinned,archived,revision FROM session_management WHERE session_id=?", (session.session_id,)).fetchone()
                if metadata:
                    session.pinned, session.archived, session.revision = bool(metadata[0]), bool(metadata[1]), metadata[2]
                if session.state in LIVE_STATES:
                    session.state = "error"
                lines = store.execute("SELECT seq, role, text, ts FROM own_session_lines WHERE session_id = ?"
                                      " ORDER BY seq DESC LIMIT ?", (session.session_id, LINES_KEPT)).fetchall()
                session.lines.extend({"seq": seq, "role": role, "text": text, "ts": ts}
                                     for seq, role, text, ts in reversed(lines))
                if lines:
                    session.seq = max(session.seq, lines[0][0])
                self.sessions[session.session_id] = session

    def process_argv(self, session, argv):
        """Configure only this owned CLI process; never mutate the user's global MCP configuration."""
        if self.computer_control is None:
            return argv
        config = self.computer_control.server(session.session_id, session.mode, self.ledger)
        if session.target == "codex":
            # JSON strings/arrays are valid TOML values; no shell is involved.
            table = "{command=" + json.dumps(config["command"]) + ",args=" + json.dumps(config["args"]) + \
                ',default_tools_approval_mode="writes",startup_timeout_sec=10,tool_timeout_sec=210}'
            return [*argv, "-c", f"mcp_servers.{SERVER_NAME}={table}"]
        name = hashlib.sha256(session.session_id.encode()).hexdigest()[:24]
        path = self.state_dir / f"own-computer-mcp-{name}.json"
        write_secret(path, json.dumps({"mcpServers": {SERVER_NAME: config}}))
        return [*argv, "--mcp-config", str(path)]

    def cancel_computer(self, session, reason):
        """Stop desktop work independently of model/tool approvals and without delaying CLI interruption."""
        config = self.computer_control
        if config is None:
            return
        desktop.release_session(config, session.session_id, reason)

    def _store_lock(self):
        return self.store._idle_lock if hasattr(self.store, "_idle_lock") else contextlib.nullcontext()

    def save(self, session):
        # A session stop_all forgot may still report its end; its row stays deleted.
        if self.store is None or self.sessions.get(session.session_id) is not session:
            return
        with self.lock, self._store_lock():
            self.store.execute(f"INSERT OR REPLACE INTO own_sessions ({', '.join(COLUMNS)})"
                               f" VALUES ({', '.join('?' * len(COLUMNS))})",
                               tuple(getattr(session, column) for column in COLUMNS))
            self.store.execute("INSERT OR REPLACE INTO session_management VALUES(?,?,?,?)",
                               (session.session_id, session.pinned, session.archived, session.revision))
            self.store.commit()

    def manage(self, session_id, body, *, delete=False):
        """Versioned product edits. Deleting only removes Agentic Complex's owned session and transcript."""
        backend = None
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None: return 404, {"error": "unknown_session"}
            if not isinstance(body, dict) or type(body.get("expected_version")) is not int:
                return 400, {"error": "invalid_session_update"}
            if body["expected_version"] != session.revision: return 409, {"error": "version_conflict"}
            allowed = {"expected_version"} if delete else {"expected_version", "title", "pinned", "archived"}
            if set(body) - allowed or (not delete and len(body) < 2):
                return 400, {"error": "invalid_session_update"}
            if any(type(body[key]) is not bool for key in ("pinned", "archived") if key in body):
                return 400, {"error": "invalid_session_update"}
            if "title" in body and (not isinstance(body["title"], str) or not 0 < len(body["title"].strip()) <= TITLE_MAX):
                return 400, {"error": "invalid_title"}
            if session.busy and (delete or body.get("archived") is True): return 409, {"error": "busy"}
            if delete:
                self.sessions.pop(session_id)
                backend, session.backend = session.backend, None
                if self.store is not None:
                    with self._store_lock():
                        self.store.execute("DELETE FROM own_session_lines WHERE session_id=?", (session_id,))
                        self.store.execute("DELETE FROM own_sessions WHERE session_id=?", (session_id,))
                        self.store.execute("DELETE FROM session_management WHERE session_id=?", (session_id,))
                        self.store.commit()
            else:
                for key in ("pinned", "archived", "title"):
                    if key in body: setattr(session, key, body[key].strip() if key == "title" else body[key])
                session.revision += 1
                self.save(session)
                return 200, session.to_dict()
        self.cancel_computer(session, "own_delete")
        try:
            ledger = EffectLedger.open(self.ledger)
            ledger.forget_run("own:" + session_id)
            ledger.db.close()
        except sqlite3.Error as e:  # no runs.sqlite yet means no receipts to forget
            log.warning("own session %s receipts not forgotten: %s", session_id, e)
        self.broker.cancel_session(session.target, session_id)
        if backend is not None: backend.stop()
        return 200, {"deleted": True}

    def create(self, target, cwd, prompt, origin=None, mode="read_only"):
        """origin: the request_id of the dispatch card that allowed it, if any."""
        if mode not in MODES:
            raise ValueError(f"unsupported mode {mode!r}")
        session = OwnSession(target, cwd, prompt, mode)
        session.origin = origin
        session.dispatch_turn = origin is not None
        with self.lock:
            self.sessions[session.session_id] = session
            self.save(session)
        if origin is not None:
            self.move_task(origin, "running", session_id=session.session_id)  # before its turn can end
        result = self.message(session.session_id, prompt)
        if origin is not None and result not in ("started", "interrupted", "failed"):
            # No turn began, so no turn end settles the task.
            self.move_task(origin, "cancelled", result={"reason": result})
            raise RuntimeError(f"dispatched session not started: {result}")
        return session

    def message(self, session_id, text):
        session = self.sessions.get(session_id)
        if session is None:
            return "unknown"
        with self.lock:
            if self.closed or self.resetting:  # shutting down, or a reset forgetting every session: no new process
                return "closed"
            if self.sessions.get(session_id) is not session: return "unknown"
            if session.archived: return "archived"
            if session.busy:
                return "busy"
            session.busy = True
            session.cancel_requested = False
            session.run = run = SessionRun()
            backend = session.backend
            if backend is not None and not backend.alive():
                # A delayed reader-exit callback belongs to the old process, not this new turn.
                session.backend = None
        created = False
        try:
            if backend is None or not backend.alive():
                if session.native_id:
                    session.resumes += 1
                if session.target == "codex":
                    self.check_codex_version()
                backend = (ClaudeProcess if session.target == "claude" else CodexProcess)(self, session)
                created = True
            with self.lock:
                if not self.run_current(session, run):
                    raise SessionCancelled()
                session.backend = run.backend = backend
                run.phase = "running"
                self.add_line(session, "user", text)
                self.progress(session, "thinking", None)
                backend.send(text)
            return "started"
        except SessionCancelled:
            if created and backend is not None:
                backend.stop(0)
            self.turn_ended(session, "interrupted", None, run=run)
            return "interrupted"
        except Exception as e:  # missing CLI, failed handshake: end the turn instead of staying busy
            if created:
                backend.stop(0)
            with self.lock:
                if not self.run_current(session, run):
                    self.turn_ended(session, "interrupted", None, run=run)
                    return "interrupted"
                session.backend = None
                self.add_line(session, "error", self.text("start_failed", target=session.target, error=type(e).__name__))
                self.turn_ended(session, "failed", None, run=run)
                return "failed"
        finally:
            run.started.set()

    def run_current(self, session, run):
        """Called under lock: a forgotten, stopped or superseded lease cannot dispatch work."""
        return not self.closed and self.sessions.get(session.session_id) is session and session.busy and \
            session.run is run and run.phase in ("starting", "running") and not run.cancelled.is_set()

    def register_backend(self, session, run, backend):
        """Publish a starting process before its protocol handshake, so stop can reach it."""
        with self.lock:
            if run is None or not self.run_current(session, run):
                return False
            run.backend = backend
            return True

    def check_codex_version(self):
        """Warn once when the installed codex is not the version the protocol lock was made from."""
        with self.lock:
            if self.codex_checked:
                return
            self.codex_checked = True
        locked = json.loads(CODEX_LOCK.read_text(encoding="utf-8"))["codex_version"]
        version = codex_version(self.argv("codex")[0])
        if version != locked:
            log.warning("codex 版本 %s 和协议锁的 %s 不同；跑本机工具 codex_protocol.py check（不在公开仓库）", version or "未知",
                        locked)

    def interrupt(self, session_id):
        session = self.sessions.get(session_id)
        if session is None:
            return "unknown"
        self.cancel_computer(session, "own_interrupt")
        with self.lock:
            if not session.busy:
                return "idle"
            session.cancel_requested = True
            run = session.run
            starting = run is not None and run.phase == "starting"
            if run is not None:
                run.cancel()
            backend = run.backend if starting else session.backend
            if backend is not None and not starting:
                backend.interrupt()  # serialized with the next turn's send, never its reply wait
        if backend is not None:
            if starting:
                backend.stop(0)
        return "interrupted"

    def ask(self, session, tool, summary, session_scope=None, targets=None, run=None):
        """The decision on a card for summary, clipped to DETAIL_MAX; None, and no card, once run is not current."""
        with self.lock:  # the turn's end cannot slip between the check and the card
            if run is not None and not self.run_current(session, run):
                return None
            self.progress(session, "awaiting_approval", None)
            request = self.broker.open(session.target, session.session_id, tool, tool_summary=summary[:DETAIL_MAX],
                                       display=session.session_id, session_scope=session_scope, targets=targets,
                                       cwd=session.cwd, summary_truncated=len(summary) > DETAIL_MAX,
                                       summary_length=len(summary),
                                       summary_sha256=hashlib.sha256(summary.encode("utf-8", "surrogatepass")).hexdigest())
        self.verdict(session, tool, request.verdict)
        return self.broker.wait(request.request_id)

    def verdict(self, session, tool, verdict):
        self.broker.report("tool.verdict", {"tool": tool, "method": verdict.method, "dangerous": verdict.dangerous,
                                            "rule": verdict.rule, "reason": verdict.reason}, session.session_id)

    def add_line(self, session, role, text):
        with self.lock:
            session.seq += 1
            line = {"seq": session.seq, "role": role, "text": text, "ts": time.time()}
            session.lines.append(line)
            # As save(): a session stop_all forgot keeps no rows.
            if self.store is not None and self.sessions.get(session.session_id) is session:
                with self._store_lock():
                    self.store.execute("INSERT INTO own_session_lines (session_id, seq, role, text, ts)"
                                       " VALUES (?, ?, ?, ?, ?)", (session.session_id, line["seq"], role, text, line["ts"]))
                    self.store.execute("DELETE FROM own_session_lines WHERE session_id = ? AND seq <= ?",
                                       (session.session_id, session.seq - LINES_KEPT))
                    self.save(session)
            else:
                self.save(session)

    def lines(self, session_id, after):
        """(lines after seq, next cursor), or None for an unknown id."""
        session = self.sessions.get(session_id)
        if session is None:
            return None
        with self.lock:
            lines = [line for line in session.lines if line["seq"] > after]
            return lines, (lines[-1]["seq"] if lines else max(after, 0))

    def progress(self, session, state, text, final=False):
        with self.lock:
            # Reader and approval threads race; an update that lands after the turn ended is stale.
            if not (final or session.busy):
                return False
            changed = session.state != state
            session.state, session.updated_at = state, time.time()
            if text:
                session.last_line = text[-LINE_MAX:]
            if changed:
                self.save(session)
            return changed

    def own_id(self, session_id):
        """The own:… id of the own session whose CLI calls itself session_id (a ledger line's id); else session_id."""
        with self.lock:
            return next((own.session_id for own in self.sessions.values() if own.native_id == session_id),
                        session_id)

    def set_native_id(self, session, native_id):
        with self.lock:
            if native_id and native_id != session.native_id:
                session.native_id = native_id
                self.save(session)

    def turn_ended(self, session, status, text, backend=None, run=None):
        """backend: the process reporting it; a report from a replaced process or for a turn already over is dropped."""
        with self.lock:
            if run is not None and session.run is not run:
                return
            if backend is not None and (session.backend is not backend or not session.busy):
                return
            session.busy = session.cancel_requested = False
            dispatched, session.dispatch_turn = session.dispatch_turn, False
            if session.run is not None:
                session.run.phase = "idle"
            session.idle_since = time.monotonic()
            if not self.progress(session, {"completed": "done", "interrupted": "idle"}.get(status, "error"), text,
                                 final=True):
                self.save(session)  # same state, newer last_line and updated_at
        self.cancel_computer(session, "own_turn_end")
        if dispatched and status == "interrupted":
            self.move_task(session.origin, "cancelled", result={"reason": "interrupted"})
        if status == "interrupted" or (status == "completed" and not dispatched):
            return
        if status == "completed":
            # A finished turn is only the CLI's answer; its verification decides, off the reader thread.
            if self.move_task(session.origin, "returned"):
                threading.Thread(target=self._verify, args=(session, text), daemon=True).start()
            return
        if dispatched:
            self.move_task(session.origin, "failed")
            kind = "dispatch_failed"
        else:
            kind = "session_failed"
        self.announce({"ts": time.time(), "level": "P1", "kind": kind, "headline": self.text(kind, target=session.target),
                       "project": session.cwd, "session_id": session.session_id,
                       "detail": text[:DETAIL_MAX] if text else None})

    def text(self, key, **fields):
        return TEXT.get(self.reply_language(), TEXT["zh-Hans"])[key].format(**fields)

    def move_task(self, task_id, state, **attrs):
        """The task's transition; False without a ledger or when the task is unknown or already past it."""
        if self.tasks is None:
            return False
        try:
            self.tasks.transition(task_id, state, **attrs)
        except ValueError:  # e.g. 「停止任务」 cancelled it before its interrupted turn ended
            return False
        return True

    def _verify(self, session, text):
        state = self.tasks.verify(session.origin)["state"]
        kind, level = {"succeeded": ("dispatch_done", "P0"), "failed": ("dispatch_failed", "P1"),
                       "needs_review": ("dispatch_review", "P2")}[state]
        self.announce({"ts": time.time(), "level": level, "kind": kind, "headline": self.text(state, target=session.target),
                       "project": session.cwd, "session_id": session.session_id,
                       "detail": text[:DETAIL_MAX] if text else None})

    def exited(self, session, backend):
        with self.lock:  # message() cannot put a successor in between
            if session.backend is not backend:
                return  # a replaced process; the cards open now are its successor's
            # Its open cards can no longer be answered.
            self.broker.cancel_session(session.target, session.session_id)
        self.turn_ended(session, "failed", None, backend=backend)

    def reap(self, now=None):
        now = time.monotonic() if now is None else now
        idle = []
        with self.lock:  # a backend taken here is one no message() reuses
            for session in self.sessions.values():
                if not session.busy and session.backend is not None and now - session.idle_since > self.idle_after:
                    idle.append((session, session.backend))
                    session.backend = None
        for session, backend in idle:
            self.cancel_computer(session, "own_idle")
            backend.stop()

    def alive(self, session_id):
        with self.lock:
            backend = self.sessions[session_id].backend
        return backend is not None and backend.alive()

    def resumed(self, session_id):
        with self.lock:
            return self.sessions[session_id].resumes > 0

    def native_ids(self):
        with self.lock:
            return {s.native_id: s for s in self.sessions.values() if s.target == "claude" and s.native_id}

    def close(self, timeout=5.0):
        """Interrupt busy sessions, then stop every backend; all within one timeout."""
        with self.lock:
            self.closed = True
        self._stop(timeout)

    def stop_all(self, timeout=5.0):
        """POST /reset: as close(), and every session is forgotten; sessions start again once they are."""
        with self.lock:
            self.resetting = True
        try:
            self._stop(timeout)
        finally:
            with self.lock:
                self.sessions.clear()
                self.resetting = False

    def clear(self):
        """Every own_sessions row and its stored lines deleted; returns how many own_sessions rows."""
        if self.store is None:
            return 0
        with self.lock, self._store_lock():
            deleted = self.store.execute("DELETE FROM own_sessions").rowcount
            self.store.execute("DELETE FROM own_session_lines")
            self.store.execute("DELETE FROM session_management")
            self.store.commit()
        return deleted

    def _stop(self, timeout):
        deadline = time.monotonic() + timeout
        with self.lock:
            sessions = list(self.sessions.values())
        for session in sessions:
            if not session.busy:
                self.cancel_computer(session, "own_stop")
            if session.busy:
                try:
                    self.interrupt(session.session_id)
                except (OSError, ValueError):  # its stdin is already closed; the stop below still runs
                    pass
        for session in sessions:
            backend = session.run.backend if session.run is not None and session.run.backend is not None else session.backend
            if backend is not None:
                backend.stop(max(0.0, deadline - time.monotonic()))
            if session.run is not None:
                session.run.started.wait(max(0.0, deadline - time.monotonic()))
