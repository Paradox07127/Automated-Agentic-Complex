"""POST /hook/claude and /hook/codex, POST /approvals/<id>/decision, and the session scope of an approval rule."""
import os
from pathlib import Path
import re
import select
import socket
import time

from sessions.events import command_text
from sessions.own import CLAUDE_ASK
from tool_gateway.policy import POLICY

DENY_MESSAGE = "Denied on the desktop character approval card."
# decide() refusals that a different request body could fix: 400 rather than 409
BAD_DECISIONS = {"invalid_decision", "invalid_mode", "unsupported_mode", "scope_unavailable"}
MESSAGE_MAX = 500  # characters of the reason a deny may carry
DECISION_KEYS = {"decision", "generation", "mode", "message"}  # what a decision body may hold
TITLE_MAX = 60  # characters of a session's first prompt shown as its title
MACHINE_BLOCK = re.compile(
    r"<(?P<tag>task-notification|system-reminder|local-command-[\w-]+|command-[\w-]+|"
    r"ide_opened_file|ide_selection|user-prompt-submit-hook)\b[^>]*>.*?</(?P=tag)\s*>", re.DOTALL)


def _broad_rule(content):
    content = re.sub(r"(?:\*|:\*|/)+$", "", content.strip()).rstrip()
    return content in ("", ".", "~", "$HOME", "${HOME}", f"/{Path.home()}")


def _broad_directory(directory):
    """True for a filesystem root, the home directory or one of its ancestors."""
    path = Path(os.path.normcase(os.path.abspath(os.path.expandvars(os.path.expanduser(directory)))))
    home = Path(os.path.normcase(os.path.abspath(os.path.expanduser("~"))))
    return path.anchor == str(path) or home.is_relative_to(path)


def session_scope(suggestions):
    """A card's session scope from an event's session-only permission updates; None when there are none."""
    if not suggestions:
        return None
    if any(not r["toolName"].strip() or _broad_rule(r.get("ruleContent", ""))
           for s in suggestions if s["type"] == "addRules" for r in s["rules"]):
        return None
    rules = [f"{r['toolName']}({r['ruleContent']})" if "ruleContent" in r else r["toolName"]
             for s in suggestions if s["type"] == "addRules" for r in s["rules"]]
    directories = [d for s in suggestions if s["type"] == "addDirectories" for d in s["directories"]]
    if any(_broad_directory(d) for d in directories):
        return None
    # detail names every rule and directory the updates grant, beside acceptEdits too
    detail = "; ".join(rules + directories) or None
    kind = "all_edits" if any(s["type"] == "setMode" for s in suggestions) else "rule"
    return {"kind": kind, "detail": detail, "updates": suggestions}


class HooksMixin:
    def _hook(self, path, event, body):
        registry, broker = self.server.registry, self.server.broker
        self.server.hook_seen[path.rsplit("/", 1)[1]] = time.time()
        if path == "/hook/codex" and self._own_codex_thread(event.session_id):
            return self._json(200, {})
        if registry.is_replay(event):
            return self._json(200, {})
        self.server.record_agent_event(event, body)
        observe = self.headers.get("X-Agentd-Observe") == "1"
        if POLICY.hook(event.source, event.kind, observe=observe).method == 'observe_only':
            self.server.ingest(event, retire=self._retire)
            if event.kind == "prompt_submit" and not event.agent_id:
                self._title(event, body)
            self.server.presence_feed.poke()
            return self._json(200, {})
        if self.server.closing:
            return self._json(503, {"error": "shutting_down"})
        own = self.server.sessions.native_ids().get(event.session_id) if self.server.sessions else None
        with registry.cv:
            if registry.superseded(event):
                return self._json(200, {})
            request = broker.open(event.source, event.session_id, event.tool_name, event.agent_id,
                                  tool_fp=event.tool_fp, tool_summary=event.tool_summary,
                                  summary_truncated=event.summary_truncated, summary_length=event.summary_length,
                                  summary_sha256=event.summary_sha256, content_preview=event.content_preview,
                                  content_preview_truncated=event.content_preview_truncated,
                                  content_preview_length=event.content_preview_length,
                                  content_preview_sha256=event.content_preview_sha256,
                                  display=own.session_id if own else None,
                                  # an own session's ask rule outranks a session allow rule: that tool asks again
                                  session_scope=None if own and event.tool_name in CLAUDE_ASK[own.mode]
                                  else session_scope(event.suggestions),
                                  targets=[command] if (command := command_text(body.get("tool_input"))) is not None
                                  else None, cwd=event.cwd)
            event.request_id = request.request_id
            registry.ingest(event)
        self.server.presence_feed.poke()
        decision = broker.wait(request.request_id, abandoned=self._peer_closed)
        outcome = {"cancelled": "retired", "abandoned": "abandoned"}.get(
            request.status, "allow" if decision == "allow_session" else decision)
        registry.approval_resolved(event.key, request.request_id, outcome)
        self.server.presence_feed.poke()
        message = None
        if decision == "deny":
            message = DENY_MESSAGE + (f" Reason from the user: {request.message}" if request.message else "")
        if decision is None:
            # No decision: Claude shows its native permission dialog.
            return self._json(200, {})
        verdict = {"behavior": decision}
        if decision == "allow_session":
            verdict = {"behavior": "allow", "updatedPermissions": request.session_scope["updates"]}
        if message:
            verdict["message"] = message
        self._json(200, {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                                "decision": verdict}})

    def _title(self, event, body):
        """The session's title from its first human prompt, one line of TITLE_MAX characters; kept only with typed_text,
        outside a pause, without secure input and when the blacklist does not hide the session."""
        prompt = body.get("prompt")
        if not isinstance(prompt, str):
            return
        prompt = MACHINE_BLOCK.sub(" ", prompt).strip()
        if not prompt:
            return
        server = self.server
        attention = server.attention
        if attention is not None:  # the window record_agent_event's prompt row is judged under
            meta = server.agent_meta and server.agent_meta.session(event.source, event.session_id,
                                                                   body.get("transcript_path"), body.get("session_title"))
            window = {"app": event.source, "bundle_id": None, "url_host": None, "title": meta and meta["title"]}
            if attention.secure_input() or attention.blacklist.hides(window):
                return
        if server.consent.snapshot()[0]["typed_text"] and not server.observation_paused():
            server.registry.set_title(event.key, " ".join(prompt.split())[:TITLE_MAX])

    def _own_codex_thread(self, session_id):
        """True when a user-level Codex hook fired inside an own session; app-server already reports it."""
        manager = self.server.sessions
        return manager is not None and any(s.target == "codex" and s.native_id == session_id
                                           for s in list(manager.sessions.values()))

    def _retire(self, event):
        """Cancel cards this event shows were answered elsewhere or can no longer matter."""
        broker, kind = self.server.broker, event.kind
        if kind in ("tool_end", "tool_failure"):
            return broker.retire(event.source, event.session_id, event.agent_id, event.tool_name,
                                 event.tool_fp)
        if kind in ("stop", "stop_failure", "interrupt"):
            return broker.cancel_agent(event.source, event.session_id, None)
        if kind == "subagent_stop" and event.agent_id:
            return broker.cancel_agent(event.source, event.session_id, event.agent_id)
        if kind == "session_end":
            return broker.cancel_session(event.source, event.session_id)
        return []

    def _peer_closed(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _decision(self, request_id, body):
        if not isinstance(body, dict):
            return self._json(400, {"error": "invalid_payload"})
        unknown = next((key for key in body if key not in DECISION_KEYS), None)
        if unknown is not None:
            return self._json(400, {"error": "invalid_payload", "field": unknown})
        message = body.get("message")
        if message is not None and not isinstance(message, str):
            return self._json(400, {"error": "invalid_payload"})
        message = (message or "").strip()[:MESSAGE_MAX] or None
        ok, reason = self.server.broker.decide(request_id, body.get("generation"), body.get("decision"),
                                               body.get("mode"), message)
        if ok:
            return self._json(200, {"ok": True})
        code = 404 if reason == "unknown_request" else 400 if reason in BAD_DECISIONS else 409
        self._json(code, {"ok": False, "error": reason})
