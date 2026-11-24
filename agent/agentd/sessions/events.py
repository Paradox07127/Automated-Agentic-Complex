"""AgentEvent v2 and hook payload normalizers for Claude Code and Codex."""
from dataclasses import asdict, dataclass
import hashlib
import itertools
import json
import math
from pathlib import PurePath
import re
import shlex
import time
from urllib.parse import urlsplit

_seq = itertools.count(1)

TOOL_CATEGORIES = {
    "read": {"read", "notebookread", "read_file", "view_image", "ls"},
    "write": {"write", "edit", "multiedit", "notebookedit", "apply_patch", "write_file", "delete", "move"},
    "command": {"bash", "bashoutput", "killshell", "killbash", "shell", "local_shell",
                "exec_command", "write_stdin", "unified_exec", "execute"},
    "search": {"grep", "glob", "websearch", "webfetch", "toolsearch", "web_search",
               "grep_files", "list_dir", "file_search", "search", "fetch"},
}

_CLAUDE_KINDS = {
    "SessionEnd": "session_end",
    "UserPromptSubmit": "prompt_submit", "PreToolUse": "tool_start",
    "PostToolUse": "tool_end", "PostToolUseFailure": "tool_failure",
    "PostToolBatch": "tool_end", "PermissionRequest": "permission_request",
    "MessageDisplay": "message", "SubagentStop": "subagent_stop",
    "Stop": "stop", "StopFailure": "stop_failure", "PreCompact": "compact_start",
    "PostCompact": "compact_end", "Notification": "notification",
}

_CODEX_KINDS = {
    "SessionEnd": "session_end",
    "UserPromptSubmit": "prompt_submit", "PreToolUse": "tool_start",
    "PostToolUse": "tool_end", "PermissionRequest": "permission_request",
    "SubagentStop": "subagent_stop",
    "Stop": "stop", "PreCompact": "compact_start", "PostCompact": "compact_end",
    "Interrupt": "interrupt",
}

_INPUT_NOTIFICATIONS = ("idle_prompt", "elicitation", "agent_needs_input")

# Card summary caps: a command stays readable up to a long one-liner; other input is a glance.
TEXT_MAX = 2000
JSON_MAX = 200
TARGET_MAX = 40
_FILE_TOOLS = {"edit", "write", "multiedit", "notebookedit", "read"}
_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")


@dataclass
class AgentEvent:
    source: str
    session_id: str
    agent_id: str | None
    parent_id: str | None
    cwd: str | None
    kind: str
    tool_name: str | None
    tool_category: str | None
    ts: float
    seq: int
    request_id: str | None = None
    turn_id: str | None = None
    tool_fp: str | None = None
    digest: str | None = None
    tool_summary: str | None = None
    tool_target: str | None = None  # the session card's short action object, see tool_target()
    origin: dict | None = None  # where the session runs, from the command hook forwarder
    suggestions: list | None = None  # Claude's offered permission updates, rebuilt as session-only allows
    summary_truncated: bool = False
    summary_length: int = 0
    summary_sha256: str | None = None
    content_preview: str | None = None
    content_preview_truncated: bool = False
    content_preview_length: int = 0
    content_preview_sha256: str | None = None

    @property
    def key(self):
        return (self.source, self.session_id)

    def to_dict(self):
        return asdict(self)


def tool_category(name):
    if not name:
        return None
    if name.startswith("mcp__"):
        return "mcp"
    lowered = name.lower()
    for category, names in TOOL_CATEGORIES.items():
        if lowered in names:
            return category
    return "other"


def _clip(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + "…"


def command_text(tool_input):
    """The whole command, an argv list joined as the shell would read it; None when there is none."""
    value = tool_input.get("command") if isinstance(tool_input, dict) else None
    if isinstance(value, str) and value:
        return value
    if isinstance(value, list) and value and all(isinstance(v, str) for v in value):
        return shlex.join(value)
    return None


def tool_summary(tool_input):
    """Command, else file path, else the start of the JSON input."""
    return _clip(*_summary(tool_input))


def _summary(tool_input):
    if isinstance(tool_input, dict):
        if isinstance(tool_input.get("command"), list) and command_text(tool_input) is not None:
            return command_text(tool_input), TEXT_MAX
        for field in ("command", "file_path", "notebook_path"):
            value = tool_input.get(field)
            if isinstance(value, str) and value:
                return value, TEXT_MAX
    return json.dumps(tool_input, ensure_ascii=False), JSON_MAX


def _program(command):
    """The first word of a shell command that is not a VAR=value assignment, as a base name; None without one."""
    try:
        words = shlex.split(command)
    except ValueError:  # an unclosed quote
        words = command.split()
    for word in words:
        if not _ASSIGNMENT.match(word):
            return PurePath(word).name or None
    return None


def tool_target(tool_name, tool_input):
    """What a tool acts on, short enough for a card line: a Bash description else its program, a file's name, a
    fetched host, a Task description, an MCP `server · tool`; None for searches and the rest. Never a whole command,
    path, pattern or file body."""
    if not tool_name or not isinstance(tool_input, dict):
        return None
    if tool_name.startswith("mcp__"):
        server, _, tool = tool_name[5:].partition("__")
        if server.startswith("ccd_") or server == "agentic_complex":
            return None
        return f"{server} · {tool}" if tool else server or None
    lowered = tool_name.lower()
    description = _text(tool_input, "description")
    if lowered in TOOL_CATEGORIES["command"]:
        if description:
            return _clip(description, TARGET_MAX)
        command = tool_input.get("command") if command_text(tool_input) else None
        # An argv list runs its first item as is; a string goes through a shell first.
        program = PurePath(command[0]).name if isinstance(command, list) else _program(command) if command else None
        return _clip(program, TARGET_MAX) if program else None
    if lowered in _FILE_TOOLS:
        path = _text(tool_input, "file_path") or _text(tool_input, "notebook_path")
        return _clip(PurePath(path).name, TARGET_MAX) if path and PurePath(path).name else None
    if lowered == "webfetch":
        url = _text(tool_input, "url")
        try:
            host = urlsplit(url).hostname if url else None
        except ValueError:
            return None
        return host or None
    if lowered in ("task", "agent"):
        return _clip(description, TARGET_MAX) if description else None
    return None


def _text(payload, field):
    value = payload.get(field)
    return value if isinstance(value, str) and value else None


def _fingerprint(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    # JSON escapes can decode to lone surrogates, which strict UTF-8 refuses.
    return hashlib.sha256(raw.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _started_at(payload, arrived):
    """When the forwarder started (`agentd_started_at`), not after arrival; else the arrival time.
    Async hooks can arrive out of order, so the start time orders them."""
    started = payload.get("agentd_started_at")
    if isinstance(started, (int, float)) and not isinstance(started, bool) and math.isfinite(started):
        return min(started, arrived)
    return arrived


def _build(source, payload, kind, now):
    if not isinstance(payload, dict):
        raise ValueError("payload_not_object")
    session_id = _text(payload, "session_id")
    if session_id is None:
        raise ValueError("missing_session_id")
    agent_id = _text(payload, "agent_id")
    tool_name = _text(payload, "tool_name")
    summary, limit = _summary(payload["tool_input"]) if "tool_input" in payload else (None, TEXT_MAX)
    tool_input = payload.get("tool_input")
    content = None
    suffix = ""
    if isinstance(tool_input, dict):
        if tool_name == "Write":
            content = tool_input.get("content")
        elif tool_name == "Edit":
            content = tool_input.get("new_string")
        elif tool_name == "NotebookEdit":
            content = tool_input.get("new_source")
        elif tool_name == "MultiEdit":
            edits = tool_input.get("edits")
            if isinstance(edits, list) and edits and all(
                    isinstance(e, dict) and isinstance(e.get("new_string"), str) for e in edits):
                content = "\n---\n".join(e["new_string"] for e in edits)
                suffix = f"\n({len(edits)} edits)"
    if not isinstance(content, str):
        content = None
    preview = content[:400] + suffix if content is not None else None
    if content is not None:
        content += suffix
    return AgentEvent(
        source=source, session_id=session_id, agent_id=agent_id,
        # Sub-agents hang under the session that spawned them.
        parent_id=session_id if agent_id else None,
        cwd=_text(payload, "cwd"), kind=kind, tool_name=tool_name,
        tool_category=tool_category(tool_name),
        ts=_started_at(payload, time.time() if now is None else now), seq=next(_seq),
        turn_id=_text(payload, "turn_id") or _text(payload, "prompt_id"),
        tool_fp=_fingerprint(payload["tool_input"]) if "tool_input" in payload else None,
        digest=_fingerprint(payload),
        tool_summary=_clip(summary, limit) if summary is not None else None,
        tool_target=tool_target(tool_name, tool_input),
        summary_truncated=summary is not None and len(summary) > limit,
        summary_length=len(summary) if summary is not None else 0,
        summary_sha256=hashlib.sha256(summary.encode("utf-8", "surrogatepass")).hexdigest()
        if summary is not None else None,
        content_preview=preview,
        content_preview_truncated=content is not None and len(content) > len(preview),
        content_preview_length=len(content) if content is not None else 0,
        content_preview_sha256=hashlib.sha256(content.encode("utf-8", "surrogatepass")).hexdigest()
        if content is not None else None,
        origin=_origin(payload.get("agentd_origin")),
        suggestions=_suggestions(payload.get("permission_suggestions")))


def _suggestion(raw):
    """One PermissionUpdate with only its known fields and destination "session"; None to drop it."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind == "addRules" and raw.get("behavior") == "allow":
        rules = raw.get("rules")
        if not isinstance(rules, list) or not rules or not all(
                isinstance(r, dict) and isinstance(r.get("toolName"), str)
                and isinstance(r.get("ruleContent", ""), str) for r in rules):
            return None
        rules = [{k: r[k] for k in ("toolName", "ruleContent") if k in r} for r in rules]
        return {"type": "addRules", "rules": rules, "behavior": "allow", "destination": "session"}
    if kind == "setMode" and raw.get("mode") == "acceptEdits":  # every other mode, bypassPermissions first, drops
        return {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
    if kind == "addDirectories":
        directories = raw.get("directories")
        if isinstance(directories, list) and directories and all(isinstance(d, str) for d in directories):
            return {"type": "addDirectories", "directories": directories, "destination": "session"}
    return None


def _suggestions(raw):
    kept = [s for s in map(_suggestion, raw) if s is not None] if isinstance(raw, list) else []
    return kept or None


ORIGIN_KINDS = ("tmux", "terminal", "desktop", "unknown")
ORIGIN_TEXT_MAX = 256
ORIGIN_EXTRA = ("entrypoint", "bundle_id", "wezterm_pane", "kitty_window_id", "kitty_listen_on")


def _origin(raw):
    """The forwarder's origin with only known, well-formed fields; None when absent."""
    if not isinstance(raw, dict):
        return None
    text = lambda k: raw[k] if isinstance(raw.get(k), str) and 0 < len(raw[k]) <= ORIGIN_TEXT_MAX else None
    tty = text("tty")
    pid = raw.get("pid")
    return {"kind": raw.get("kind") if raw.get("kind") in ORIGIN_KINDS else "unknown",
            "term_program": text("term_program"), "tty": tty if tty and tty.startswith("/dev/") else None,
            "tmux_pane": text("tmux_pane"), "tmux_socket": text("tmux_socket"),
            "pid": pid if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 else None,
            **{k: text(k) for k in ORIGIN_EXTRA}}


def normalize_claude(payload, now=None):
    name = payload.get("hook_event_name") if isinstance(payload, dict) else None
    kind = _CLAUDE_KINDS.get(name, "other")
    if kind == "notification":
        ntype = payload.get("notification_type") or ""
        if ntype.startswith(_INPUT_NOTIFICATIONS):
            kind = "awaiting_input"
    if kind == "tool_start" and payload.get("tool_name") == "AskUserQuestion":
        kind = "awaiting_input"
    return _build("claude", payload, kind, now)


def normalize_codex(payload, now=None):
    name = payload.get("hook_event_name") if isinstance(payload, dict) else None
    return _build("codex", payload, _CODEX_KINDS.get(name, "other"), now)
